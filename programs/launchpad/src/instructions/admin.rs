use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::state::{ConfigParams, GlobalConfig};

impl ConfigParams {
    pub fn validate(&self) -> Result<()> {
        let total_fee = self.protocol_fee_bps as u32 + self.creator_fee_bps as u32;
        require!(
            total_fee <= MAX_TOTAL_FEE_BPS as u32,
            LaunchpadError::InvalidConfig
        );
        require!(self.curve_token_supply > 0, LaunchpadError::InvalidConfig);
        // Something must be left over for the Raydium pool.
        require!(
            self.token_total_supply > self.curve_token_supply,
            LaunchpadError::InvalidConfig
        );
        // The virtual token reserve must exceed what the curve sells, or the
        // price would go to infinity before the curve completes.
        require!(
            self.initial_virtual_token_reserves > self.curve_token_supply,
            LaunchpadError::InvalidConfig
        );
        require!(
            self.initial_virtual_sol_reserves > 0,
            LaunchpadError::InvalidConfig
        );
        require!(
            self.raydium_cpmm_program != Pubkey::default()
                && self.raydium_amm_config != Pubkey::default()
                && self.raydium_create_pool_fee != Pubkey::default(),
            LaunchpadError::InvalidConfig
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: the program's ProgramData account; verified in the handler so
    /// that nobody but the deployer can win the race to initialize.
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    fee_recipient: Pubkey,
    params: ConfigParams,
) -> Result<()> {
    #[cfg(not(feature = "local-testing"))]
    {
        #[allow(deprecated)]
        use anchor_lang::solana_program::bpf_loader_upgradeable;
        let (expected, _) =
            Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            expected,
            LaunchpadError::NotUpgradeAuthority
        );
        let info = &ctx.accounts.program_data;
        require_keys_eq!(
            *info.owner,
            bpf_loader_upgradeable::ID,
            LaunchpadError::NotUpgradeAuthority
        );
        let program_data = ProgramData::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        require!(
            program_data.upgrade_authority_address == Some(ctx.accounts.admin.key()),
            LaunchpadError::NotUpgradeAuthority
        );
    }

    params.validate()?;
    require!(
        fee_recipient != Pubkey::default(),
        LaunchpadError::InvalidConfig
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = Pubkey::default();
    config.fee_recipient = fee_recipient;
    config.paused = false;
    config.params = params;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LaunchpadError::NotAdmin,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    ctx.accounts.config.params = params;
    Ok(())
}

pub fn set_fee_recipient(ctx: Context<AdminOnly>, fee_recipient: Pubkey) -> Result<()> {
    require!(
        fee_recipient != Pubkey::default(),
        LaunchpadError::InvalidConfig
    );
    ctx.accounts.config.fee_recipient = fee_recipient;
    Ok(())
}

pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_admin != Pubkey::default()
            && config.pending_admin == ctx.accounts.new_admin.key(),
        LaunchpadError::NotPendingAdmin
    );
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();
    Ok(())
}
