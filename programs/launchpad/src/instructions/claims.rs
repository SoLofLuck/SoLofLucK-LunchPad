use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, Token2022, TokenAccount, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{CreatorFeesClaimed, CreatorLockClaimed, ProtocolFeesCollected};
use crate::instructions::shared::{assert_solvent, pay_from_vault};
use crate::state::{BondingCurve, GlobalConfig};

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [CURVE_SEED, curve.mint.as_ref()],
        bump = curve.bump,
        has_one = creator @ LaunchpadError::NotCreator,
    )]
    pub curve: Account<'info, BondingCurve>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, curve.mint.as_ref()],
        bump = curve.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let curve = &mut ctx.accounts.curve;
    let amount = curve.creator_fees_accrued;
    require!(amount > 0, LaunchpadError::NothingToClaim);
    curve.creator_fees_accrued = 0;
    pay_from_vault(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        &curve.mint,
        curve.sol_vault_bump,
        amount,
    )?;
    assert_solvent(curve, &ctx.accounts.sol_vault.to_account_info())?;
    emit!(CreatorFeesClaimed {
        mint: curve.mint,
        creator: curve.creator,
        amount,
    });
    Ok(())
}

/// Permissionless: anyone may push a curve's protocol fees to the configured
/// fee recipient (a crank, the admin, or a curious user).
#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [CURVE_SEED, curve.mint.as_ref()],
        bump = curve.bump,
    )]
    pub curve: Account<'info, BondingCurve>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, curve.mint.as_ref()],
        bump = curve.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// CHECK: must equal config.fee_recipient; only receives lamports.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
    let curve = &mut ctx.accounts.curve;
    let amount = curve.protocol_fees_accrued;
    require!(amount > 0, LaunchpadError::NothingToClaim);
    curve.protocol_fees_accrued = 0;
    pay_from_vault(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.fee_recipient.to_account_info(),
        &curve.mint,
        curve.sol_vault_bump,
        amount,
    )?;
    assert_solvent(curve, &ctx.accounts.sol_vault.to_account_info())?;
    emit!(ProtocolFeesCollected {
        mint: curve.mint,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimCreatorLock<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = creator @ LaunchpadError::NotCreator,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

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
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_creator_lock(ctx: Context<ClaimCreatorLock>) -> Result<()> {
    let curve = &mut ctx.accounts.curve;
    let amount = curve.creator_locked_tokens;
    require!(amount > 0, LaunchpadError::NothingToClaim);
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= curve.creator_unlock_at,
        LaunchpadError::CreatorLocked
    );
    curve.creator_locked_tokens = 0;

    let mint_key = ctx.accounts.mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[CURVE_SEED, mint_key.as_ref(), &[curve.bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.curve_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: curve.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        TOKEN_DECIMALS,
    )?;

    emit!(CreatorLockClaimed {
        mint: mint_key,
        creator: curve.creator,
        amount,
    });
    Ok(())
}
