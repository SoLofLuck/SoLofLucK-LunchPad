use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_2022_extensions::{
    token_metadata_initialize, token_metadata_update_authority, TokenMetadataInitialize,
    TokenMetadataUpdateAuthority,
};
use anchor_spl::token_interface::{
    mint_to, set_authority, Mint, MintTo, SetAuthority, Token2022, TokenAccount,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{CurveCompleted, TokenCreated, Trade};
use crate::instructions::shared::{assert_solvent, pay_into_vault};
use crate::math;
use crate::state::{BondingCurve, CurveStatus, GlobalConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// One of SELL_LOCK_OPTIONS.
    pub sell_lock_seconds: i64,
    /// One of CREATOR_LOCK_OPTIONS. Applies to the initial buy below.
    pub creator_lock_seconds: i64,
    /// Optional first buy by the creator, in lamports (fees included). The
    /// tokens are held by the curve under the Creator Lock.
    pub initial_buy_lamports: u64,
    pub min_tokens_out: u64,
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        signer,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve,
        mint::token_program = token_program,
        extensions::metadata_pointer::authority = curve,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    /// Holds this token's SOL; funded with its rent minimum here.
    #[account(mut, seeds = [SOL_VAULT_SEED, mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create(ctx: Context<Create>, args: CreateArgs) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, LaunchpadError::Paused);
    require!(
        !args.name.trim().is_empty() && args.name.len() <= MAX_NAME_LEN,
        LaunchpadError::InvalidMetadata
    );
    require!(
        !args.symbol.trim().is_empty() && args.symbol.len() <= MAX_SYMBOL_LEN,
        LaunchpadError::InvalidMetadata
    );
    require!(
        !args.uri.is_empty() && args.uri.len() <= MAX_URI_LEN,
        LaunchpadError::InvalidMetadata
    );
    require!(
        SELL_LOCK_OPTIONS.contains(&args.sell_lock_seconds),
        LaunchpadError::InvalidSellLock
    );
    require!(
        CREATOR_LOCK_OPTIONS.contains(&args.creator_lock_seconds),
        LaunchpadError::InvalidCreatorLock
    );

    let now = Clock::get()?.unix_timestamp;
    let p = config.params;
    let mint_key = ctx.accounts.mint.key();
    let curve_bump = ctx.bumps.curve;

    {
        let curve = &mut ctx.accounts.curve;
        curve.mint = mint_key;
        curve.creator = ctx.accounts.creator.key();
        curve.status = CurveStatus::Trading;
        curve.virtual_token_reserves = p.initial_virtual_token_reserves;
        curve.virtual_sol_reserves = p.initial_virtual_sol_reserves;
        curve.real_token_reserves = p.curve_token_supply;
        curve.real_sol_reserves = 0;
        curve.lp_token_reserve = p.token_total_supply - p.curve_token_supply;
        curve.token_total_supply = p.token_total_supply;
        curve.protocol_fee_bps = p.protocol_fee_bps;
        curve.creator_fee_bps = p.creator_fee_bps;
        curve.migration_fee_lamports = p.migration_fee_lamports;
        curve.pool_creation_budget_lamports = p.pool_creation_budget_lamports;
        curve.creator_fees_accrued = 0;
        curve.protocol_fees_accrued = 0;
        curve.created_at = now;
        curve.sell_unlock_at = now + args.sell_lock_seconds;
        curve.creator_locked_tokens = 0;
        curve.creator_unlock_at = now + args.creator_lock_seconds;
        curve.raydium_pool = Pubkey::default();
        curve.bump = curve_bump;
        curve.sol_vault_bump = ctx.bumps.sol_vault;
    }

    let vault_rent = Rent::get()?
        .minimum_balance(0)
        .saturating_sub(ctx.accounts.sol_vault.lamports());
    pay_into_vault(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        vault_rent,
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[CURVE_SEED, mint_key.as_ref(), &[curve_bump]]];

    // --- Metadata (stored in the mint itself: Token-2022 metadata extension).
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(ctx.accounts.curve.key()))
            .map_err(|_| error!(LaunchpadError::InvalidMetadata))?,
        mint: mint_key,
        name: args.name.clone(),
        symbol: args.symbol.clone(),
        uri: args.uri.clone(),
        additional_metadata: vec![],
    };
    let extra_space = metadata
        .tlv_size_of()
        .map_err(|_| error!(LaunchpadError::InvalidMetadata))?;
    let mint_info = ctx.accounts.mint.to_account_info();
    let new_len = mint_info.data_len() + extra_space;
    let lamports_needed = Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(mint_info.lamports());
    if lamports_needed > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: mint_info.clone(),
                },
            ),
            lamports_needed,
        )?;
    }

    let token_program = ctx.accounts.token_program.to_account_info();
    let curve_info = ctx.accounts.curve.to_account_info();

    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                mint: mint_info.clone(),
                metadata: mint_info.clone(),
                mint_authority: curve_info.clone(),
                update_authority: curve_info.clone(),
            },
            signer_seeds,
        ),
        args.name.clone(),
        args.symbol.clone(),
        args.uri.clone(),
    )?;

    // Metadata is now immutable: nobody can change the name, logo or links.
    token_metadata_update_authority(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataUpdateAuthority {
                program_id: token_program.clone(),
                metadata: mint_info.clone(),
                current_authority: curve_info.clone(),
                new_authority: curve_info.clone(),
            },
            signer_seeds,
        ),
        OptionalNonZeroPubkey::default(),
    )?;

    // --- Supply: mint everything once, then revoke the mint authority forever.
    mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: mint_info.clone(),
                to: ctx.accounts.curve_vault.to_account_info(),
                authority: curve_info.clone(),
            },
            signer_seeds,
        ),
        p.token_total_supply,
    )?;
    set_authority(
        CpiContext::new_with_signer(
            token_program.clone(),
            SetAuthority {
                current_authority: curve_info.clone(),
                account_or_mint: mint_info.clone(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    emit!(TokenCreated {
        mint: mint_key,
        curve: ctx.accounts.curve.key(),
        creator: ctx.accounts.creator.key(),
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        sell_unlock_at: ctx.accounts.curve.sell_unlock_at,
        creator_unlock_at: ctx.accounts.curve.creator_unlock_at,
        timestamp: now,
    });

    // --- Optional initial buy, held under the Creator Lock.
    if args.initial_buy_lamports > 0 {
        let curve = &mut ctx.accounts.curve;
        let quote = math::quote_buy(
            &curve.reserves(),
            args.initial_buy_lamports,
            curve.protocol_fee_bps,
            curve.creator_fee_bps,
        )
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        require!(quote.tokens_out > 0, LaunchpadError::ZeroAmount);
        require!(
            quote.tokens_out >= args.min_tokens_out,
            LaunchpadError::SlippageExceeded
        );

        pay_into_vault(
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.sol_vault.to_account_info(),
            quote.total_cost,
        )?;

        let next = math::apply_buy(&curve.reserves(), &quote)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        curve.set_reserves(&next);
        curve.add_fees(quote.fees.protocol, quote.fees.creator)?;
        curve.creator_locked_tokens = quote.tokens_out;
        if quote.completes_curve {
            curve.status = CurveStatus::Complete;
        }
        assert_solvent(curve, &ctx.accounts.sol_vault.to_account_info())?;

        emit!(Trade {
            mint: mint_key,
            trader: curve.creator,
            is_buy: true,
            sol_amount: quote.sol_in,
            token_amount: quote.tokens_out,
            protocol_fee: quote.fees.protocol,
            creator_fee: quote.fees.creator,
            virtual_sol_reserves: next.virtual_sol,
            virtual_token_reserves: next.virtual_token,
            real_sol_reserves: next.real_sol,
            real_token_reserves: next.real_token,
            timestamp: now,
        });
        if quote.completes_curve {
            emit!(CurveCompleted {
                mint: mint_key,
                real_sol_reserves: next.real_sol,
                timestamp: now,
            });
        }
    }

    Ok(())
}
