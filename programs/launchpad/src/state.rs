use anchor_lang::prelude::*;

/// Global, admin-controlled settings. Every curve copies the values it depends
/// on when it is created, so changing the config never changes the rules of a
/// token that is already live.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    /// Two-step admin handover: `transfer_admin` sets this, `accept_admin`
    /// completes it. `Pubkey::default()` means no handover is pending.
    pub pending_admin: Pubkey,
    /// Receives protocol trading fees and the migration fee.
    pub fee_recipient: Pubkey,
    /// Pauses `create` and `buy` only. Selling, claiming and migrating always
    /// stay open, so a pause can never trap anyone's funds.
    pub paused: bool,
    pub params: ConfigParams,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct ConfigParams {
    /// Protocol share of every trade, in basis points of the SOL amount.
    pub protocol_fee_bps: u16,
    /// Creator share of every trade, in basis points of the SOL amount.
    pub creator_fee_bps: u16,
    /// Total supply minted for each token (base units, 6 decimals).
    pub token_total_supply: u64,
    /// Of that supply, how much is sold along the bonding curve. The rest is
    /// reserved for the Raydium pool.
    pub curve_token_supply: u64,
    /// Virtual reserves the curve starts from; they set the starting price
    /// and the steepness of the curve.
    pub initial_virtual_token_reserves: u64,
    pub initial_virtual_sol_reserves: u64,
    /// Kept by the protocol out of the raised SOL at graduation. Together with
    /// the pool creation budget it also covers Raydium's costs, so graduation
    /// keeps working if those costs rise after a token was created.
    pub migration_fee_lamports: u64,
    /// Handed to the pool authority to pay Raydium's pool creation fee and the
    /// rent of the pool accounts. Whatever is left afterwards is swept to
    /// `fee_recipient`.
    pub pool_creation_budget_lamports: u64,
    pub raydium_cpmm_program: Pubkey,
    pub raydium_amm_config: Pubkey,
    pub raydium_create_pool_fee: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CurveStatus {
    /// Buying and (once the Sell Lock expires) selling on the curve.
    Trading,
    /// Every curve token is sold; waiting for `migrate`.
    Complete,
    /// Liquidity is on Raydium and the LP tokens are burned.
    Migrated,
}

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub status: CurveStatus,

    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    /// Tokens still for sale on the curve.
    pub real_token_reserves: u64,
    /// SOL paid in by buyers (net of fees) and not yet paid back out.
    pub real_sol_reserves: u64,
    /// Tokens held back for the Raydium pool.
    pub lp_token_reserve: u64,
    pub token_total_supply: u64,

    // Snapshot of the config at creation.
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub migration_fee_lamports: u64,
    pub pool_creation_budget_lamports: u64,

    /// Fees stay in the SOL vault and are paid out on claim. Paying them out on
    /// every trade would let a recipient that empties its wallet below the
    /// rent minimum make every trade fail.
    pub creator_fees_accrued: u64,
    pub protocol_fees_accrued: u64,

    pub created_at: i64,
    /// Sell Lock: selling to the curve, and graduation, open at this time.
    pub sell_unlock_at: i64,
    /// Creator Lock: the creator's initial buy, held in the curve vault.
    pub creator_locked_tokens: u64,
    pub creator_unlock_at: i64,

    /// Set on migration.
    pub raydium_pool: Pubkey,
    pub bump: u8,
    pub sol_vault_bump: u8,
    pub _reserved: [u8; 64],
}
