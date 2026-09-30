//! Graduation: once every curve token is sold (and the Sell Lock has expired),
//! anyone can move the liquidity to a Raydium CPMM pool.
//!
//! 1. The raised SOL pays the migration fee and a fixed pool creation budget;
//!    the rest becomes the pool's SOL side.
//! 2. The token side is sized so the pool opens at exactly the curve's final
//!    price. Reserved tokens that are not needed for that are burned.
//! 3. The token's SOL vault (a system-owned PDA) creates the pool: Raydium
//!    needs a creator that can pay its fee and rent through the System
//!    Program. It spends at most the pool creation budget; the rest of the
//!    budget is swept to the fee recipient.
//! 4. Every LP token the pool mints is burned, so the liquidity can never be
//!    pulled.
//!
//! The pool account is a fresh keypair signed by the caller, not Raydium's
//! deterministic PDA. That PDA depends only on (config, mint, WSOL), so anyone
//! could create it first with a dust pool and block graduation forever.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token};
use anchor_spl::token_interface::{
    burn, close_account, transfer_checked, Burn, CloseAccount, Mint, Token2022, TokenAccount,
    TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::Migrated;
use crate::instructions::shared::assert_solvent;
use crate::math;
use crate::state::{BondingCurve, CurveStatus, GlobalConfig};

#[derive(Accounts)]
pub struct Migrate<'info> {
    /// Anyone. Pays the rent of the two temporary token accounts and gets it
    /// back at the end.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump = curve.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = sol_vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = sol_vault,
        associated_token::token_program = spl_token_program,
    )]
    pub vault_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: receives the leftover pool creation budget.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// CHECK: pinned by the config.
    #[account(address = config.params.raydium_cpmm_program @ LaunchpadError::InvalidRaydiumAccount)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: pinned by the config.
    #[account(address = config.params.raydium_amm_config @ LaunchpadError::InvalidRaydiumAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium's vault/LP authority PDA; Raydium checks it.
    pub raydium_authority: UncheckedAccount<'info>,
    /// A fresh keypair; see the module docs.
    #[account(mut)]
    pub pool_state: Signer<'info>,
    /// CHECK: created and checked by Raydium.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: the pool authority's LP token account; created by Raydium.
    #[account(mut)]
    pub vault_lp: UncheckedAccount<'info>,
    /// CHECK: created and checked by Raydium.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: created and checked by Raydium.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: pinned by the config.
    #[account(mut, address = config.params.raydium_create_pool_fee @ LaunchpadError::InvalidRaydiumAccount)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: created and checked by Raydium.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub spl_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// SPL token account layout: the amount is the u64 at byte 64.
fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 72, LaunchpadError::InvalidRaydiumAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mint_key = ctx.accounts.mint.key();

    // --- Checks and amounts -------------------------------------------------
    let (sol_to_pool, tokens_to_pool, tokens_to_burn, migration_fee) = {
        let curve = &ctx.accounts.curve;
        match curve.status {
            CurveStatus::Trading => return err!(LaunchpadError::CurveNotComplete),
            CurveStatus::Migrated => return err!(LaunchpadError::AlreadyMigrated),
            CurveStatus::Complete => {}
        }
        require!(now >= curve.sell_unlock_at, LaunchpadError::SellLocked);

        let r = curve.reserves();
        let fee = curve.migration_fee_lamports;
        let budget = curve.pool_creation_budget_lamports;
        let costs = fee
            .checked_add(budget)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        require!(r.real_sol > costs, LaunchpadError::MigrationUnderfunded);
        let sol_to_pool = r.real_sol - costs;

        let tokens_to_pool = math::tokens_for_price(&r, sol_to_pool)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?
            .min(curve.lp_token_reserve);
        require!(tokens_to_pool > 0, LaunchpadError::ZeroAmount);
        let tokens_to_burn = curve.lp_token_reserve - tokens_to_pool + r.real_token;
        (sol_to_pool, tokens_to_pool, tokens_to_burn, fee)
    };

    // --- Bookkeeping first, then move the value out. -----------------------
    {
        let curve = &mut ctx.accounts.curve;
        curve.real_sol_reserves = 0;
        curve.real_token_reserves = 0;
        curve.lp_token_reserve = 0;
        curve.protocol_fees_accrued = curve
            .protocol_fees_accrued
            .checked_add(migration_fee)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        curve.status = CurveStatus::Migrated;
        curve.raydium_pool = ctx.accounts.pool_state.key();
    }

    let curve_bump = ctx.accounts.curve.bump;
    let curve_seeds: &[&[&[u8]]] = &[&[CURVE_SEED, mint_key.as_ref(), &[curve_bump]]];
    let authority_bump = ctx.accounts.curve.sol_vault_bump;
    let authority_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, mint_key.as_ref(), &[authority_bump]]];

    let token_program = ctx.accounts.token_program.to_account_info();
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TransferChecked {
                from: ctx.accounts.curve_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            curve_seeds,
        ),
        tokens_to_pool,
        TOKEN_DECIMALS,
    )?;
    if tokens_to_burn > 0 {
        burn(
            CpiContext::new_with_signer(
                token_program.clone(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                curve_seeds,
            ),
            tokens_to_burn,
        )?;
    }

    // Wrap the pool's SOL side.
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sol_vault.to_account_info(),
                to: ctx.accounts.vault_wsol.to_account_info(),
            },
            authority_seeds,
        ),
        sol_to_pool,
    )?;
    token::sync_native(CpiContext::new(
        ctx.accounts.spl_token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.vault_wsol.to_account_info(),
        },
    ))?;

    // --- Raydium CPMM `initialize` ------------------------------------------
    // Raydium orders the pair by mint address.
    let mint_is_token_0 = mint_key < WSOL_MINT;
    let a = &ctx.accounts;
    let (mint_0, mint_1, user_0, user_1, program_0, program_1, amount_0, amount_1) =
        if mint_is_token_0 {
            (
                a.mint.to_account_info(),
                a.wsol_mint.to_account_info(),
                a.vault_token.to_account_info(),
                a.vault_wsol.to_account_info(),
                a.token_program.to_account_info(),
                a.spl_token_program.to_account_info(),
                tokens_to_pool,
                sol_to_pool,
            )
        } else {
            (
                a.wsol_mint.to_account_info(),
                a.mint.to_account_info(),
                a.vault_wsol.to_account_info(),
                a.vault_token.to_account_info(),
                a.spl_token_program.to_account_info(),
                a.token_program.to_account_info(),
                sol_to_pool,
                tokens_to_pool,
            )
        };

    let infos = [
        a.sol_vault.to_account_info(),
        a.amm_config.to_account_info(),
        a.raydium_authority.to_account_info(),
        a.pool_state.to_account_info(),
        mint_0,
        mint_1,
        a.lp_mint.to_account_info(),
        user_0,
        user_1,
        a.vault_lp.to_account_info(),
        a.token_0_vault.to_account_info(),
        a.token_1_vault.to_account_info(),
        a.create_pool_fee.to_account_info(),
        a.observation_state.to_account_info(),
        a.spl_token_program.to_account_info(),
        program_0,
        program_1,
        a.associated_token_program.to_account_info(),
        a.system_program.to_account_info(),
        a.rent.to_account_info(),
    ];
    let writable = [
        true, false, false, true, false, false, true, true, true, true, true, true, true, true,
        false, false, false, false, false, false,
    ];
    let metas = infos
        .iter()
        .zip(writable)
        .enumerate()
        .map(|(i, (info, w))| {
            // Signers: the creator (pool authority, via seeds) and pool_state.
            let signer = i == 0 || i == 3;
            if w {
                AccountMeta::new(info.key(), signer)
            } else {
                AccountMeta::new_readonly(info.key(), signer)
            }
        })
        .collect::<Vec<_>>();

    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&CPMM_INITIALIZE_DISCRIMINATOR);
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // open_time: now
    let ix = Instruction {
        program_id: a.cpmm_program.key(),
        accounts: metas,
        data,
    };
    let mut cpi_infos = infos.to_vec();
    cpi_infos.push(a.cpmm_program.to_account_info());
    invoke_signed(&ix, &cpi_infos, authority_seeds)?;

    // --- Burn every LP token: the liquidity is permanent. ------------------
    let lp_amount = token_amount(&a.vault_lp.to_account_info())?;
    if lp_amount > 0 {
        token::burn(
            CpiContext::new_with_signer(
                a.spl_token_program.to_account_info(),
                token::Burn {
                    mint: a.lp_mint.to_account_info(),
                    from: a.vault_lp.to_account_info(),
                    authority: a.sol_vault.to_account_info(),
                },
                authority_seeds,
            ),
            lp_amount,
        )?;
    }

    // --- Clean up: return temp account rent, sweep the unused budget. -----
    if token_amount(&a.vault_token.to_account_info())? == 0 {
        close_account(CpiContext::new_with_signer(
            token_program.clone(),
            CloseAccount {
                account: a.vault_token.to_account_info(),
                destination: a.payer.to_account_info(),
                authority: a.sol_vault.to_account_info(),
            },
            authority_seeds,
        ))?;
    }
    if token_amount(&a.vault_wsol.to_account_info())? == 0 {
        close_account(CpiContext::new_with_signer(
            a.spl_token_program.to_account_info(),
            CloseAccount {
                account: a.vault_wsol.to_account_info(),
                destination: a.payer.to_account_info(),
                authority: a.sol_vault.to_account_info(),
            },
            authority_seeds,
        ))?;
    }
    // Whatever Raydium did not use of the pool creation budget. The solvency
    // check that follows proves Raydium stayed within the budget: the vault
    // must still hold its rent minimum plus every fee it owes.
    let required = a.curve.required_vault_lamports()?;
    let leftover = a.sol_vault.lamports().saturating_sub(required);
    if leftover > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.to_account_info(),
                system_program::Transfer {
                    from: a.sol_vault.to_account_info(),
                    to: a.fee_recipient.to_account_info(),
                },
                authority_seeds,
            ),
            leftover,
        )?;
    }
    assert_solvent(&a.curve, &a.sol_vault.to_account_info())?;

    emit!(Migrated {
        mint: mint_key,
        pool: a.pool_state.key(),
        sol_to_pool,
        tokens_to_pool,
        tokens_burned: tokens_to_burn,
        migration_fee,
        timestamp: now,
    });
    Ok(())
}
