//! SoLofLuck LaunchPad — fair-launch tokens on a bonding curve that graduate
//! to Raydium CPMM.
//!
//! See docs/ARCHITECTURE.md for the full design.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;
use state::ConfigParams;

declare_id!("joU7UkoHdwYHkrPaswt4K36LQ2aB1NfLNkN51p7HUSc");

// Anchor 0.31's generated code calls the (deprecated) AccountInfo::realloc.
#[allow(deprecated)]
#[program]
pub mod launchpad {
    use super::*;

    // --- Admin -------------------------------------------------------------

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_recipient: Pubkey,
        params: ConfigParams,
    ) -> Result<()> {
        instructions::admin::initialize_config(ctx, fee_recipient, params)
    }

    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        instructions::admin::update_config(ctx, params)
    }

    pub fn set_fee_recipient(ctx: Context<AdminOnly>, fee_recipient: Pubkey) -> Result<()> {
        instructions::admin::set_fee_recipient(ctx, fee_recipient)
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::transfer_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    // --- Launch & trade ----------------------------------------------------

    pub fn create(ctx: Context<Create>, args: CreateArgs) -> Result<()> {
        instructions::create::create(ctx, args)
    }

    pub fn buy(ctx: Context<Buy>, max_sol_cost: u64, min_tokens_out: u64) -> Result<()> {
        instructions::trade::buy(ctx, max_sol_cost, min_tokens_out)
    }

    pub fn sell(ctx: Context<Sell>, token_amount: u64, min_sol_out: u64) -> Result<()> {
        instructions::trade::sell(ctx, token_amount, min_sol_out)
    }

    // --- Graduation --------------------------------------------------------

    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        instructions::migrate::migrate(ctx)
    }

    // --- Claims ------------------------------------------------------------

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claims::claim_creator_fees(ctx)
    }

    pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
        instructions::claims::collect_protocol_fees(ctx)
    }

    pub fn claim_creator_lock(ctx: Context<ClaimCreatorLock>) -> Result<()> {
        instructions::claims::claim_creator_lock(ctx)
    }
}
