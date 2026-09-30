use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, Token2022, TokenAccount, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{CurveCompleted, Trade};
use crate::instructions::shared::{assert_solvent, pay_from_vault, pay_into_vault};
use crate::math;
use crate::state::{BondingCurve, CurveStatus, GlobalConfig};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump = curve.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Spend up to `max_sol_cost` lamports (fees included) on tokens, receiving at
/// least `min_tokens_out`. If the curve has fewer tokens left than that buys,
/// the buy takes the rest, costs less, and completes the curve.
pub fn buy(ctx: Context<Buy>, max_sol_cost: u64, min_tokens_out: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, LaunchpadError::Paused);
    require!(max_sol_cost > 0, LaunchpadError::ZeroAmount);

    let curve = &mut ctx.accounts.curve;
    require!(
        curve.status == CurveStatus::Trading,
        LaunchpadError::CurveComplete
    );

    let quote = math::quote_buy(
        &curve.reserves(),
        max_sol_cost,
        curve.protocol_fee_bps,
        curve.creator_fee_bps,
    )
    .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
    require!(quote.tokens_out > 0, LaunchpadError::ZeroAmount);
    require!(
        quote.tokens_out >= min_tokens_out,
        LaunchpadError::SlippageExceeded
    );

    pay_into_vault(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        quote.total_cost,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[CURVE_SEED, mint_key.as_ref(), &[curve.bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.curve_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: curve.to_account_info(),
            },
            signer_seeds,
        ),
        quote.tokens_out,
        TOKEN_DECIMALS,
    )?;

    let next = math::apply_buy(&curve.reserves(), &quote)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
    curve.set_reserves(&next);
    curve.add_fees(quote.fees.protocol, quote.fees.creator)?;
    if quote.completes_curve {
        curve.status = CurveStatus::Complete;
    }
    assert_solvent(curve, &ctx.accounts.sol_vault.to_account_info())?;

    let now = Clock::get()?.unix_timestamp;
    emit!(Trade {
        mint: mint_key,
        trader: ctx.accounts.buyer.key(),
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
    Ok(())
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump = curve.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

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
        token::mint = mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Sell `token_amount` tokens back to the curve for at least `min_sol_out`
/// lamports (after fees). Rejected while the Sell Lock is active. Selling is
/// deliberately NOT affected by the admin pause.
pub fn sell(ctx: Context<Sell>, token_amount: u64, min_sol_out: u64) -> Result<()> {
    require!(token_amount > 0, LaunchpadError::ZeroAmount);

    let curve = &mut ctx.accounts.curve;
    require!(
        curve.status == CurveStatus::Trading,
        LaunchpadError::CurveComplete
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= curve.sell_unlock_at, LaunchpadError::SellLocked);

    let quote = math::quote_sell(
        &curve.reserves(),
        token_amount,
        curve.protocol_fee_bps,
        curve.creator_fee_bps,
    )
    .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
    require!(quote.net_to_seller > 0, LaunchpadError::ZeroAmount);
    require!(
        quote.net_to_seller >= min_sol_out,
        LaunchpadError::SlippageExceeded
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.seller_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.curve_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        token_amount,
        TOKEN_DECIMALS,
    )?;

    let next = math::apply_sell(&curve.reserves(), token_amount, &quote)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
    curve.set_reserves(&next);
    curve.add_fees(quote.fees.protocol, quote.fees.creator)?;

    pay_from_vault(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.mint.key(),
        curve.sol_vault_bump,
        quote.net_to_seller,
    )?;
    assert_solvent(curve, &ctx.accounts.sol_vault.to_account_info())?;

    emit!(Trade {
        mint: ctx.accounts.mint.key(),
        trader: ctx.accounts.seller.key(),
        is_buy: false,
        sol_amount: quote.sol_out,
        token_amount,
        protocol_fee: quote.fees.protocol,
        creator_fee: quote.fees.creator,
        virtual_sol_reserves: next.virtual_sol,
        virtual_token_reserves: next.virtual_token,
        real_sol_reserves: next.real_sol,
        real_token_reserves: next.real_token,
        timestamp: now,
    });
    Ok(())
}
