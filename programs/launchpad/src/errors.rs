use anchor_lang::prelude::*;

#[error_code]
pub enum LaunchpadError {
    #[msg("Only the admin can do this.")]
    NotAdmin,
    #[msg("Only the pending admin can accept the admin role.")]
    NotPendingAdmin,
    #[msg("Only the program's upgrade authority can initialize the config.")]
    NotUpgradeAuthority,
    #[msg("The launchpad is paused: creating tokens and buying are disabled.")]
    Paused,
    #[msg("A config parameter is out of range.")]
    InvalidConfig,
    #[msg("The token name, symbol or URI is empty or too long.")]
    InvalidMetadata,
    #[msg("That Sell Lock duration is not one of the allowed options.")]
    InvalidSellLock,
    #[msg("That Creator Lock duration is not one of the allowed options.")]
    InvalidCreatorLock,
    #[msg("The amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Slippage exceeded: the price moved past your limit.")]
    SlippageExceeded,
    #[msg("The bonding curve is complete; trade on Raydium once it has migrated.")]
    CurveComplete,
    #[msg("The bonding curve is not complete yet.")]
    CurveNotComplete,
    #[msg("This token has already migrated to Raydium.")]
    AlreadyMigrated,
    #[msg("Sell Lock is active: selling opens when the lock expires. Buying is open.")]
    SellLocked,
    #[msg("The Creator Lock has not expired yet.")]
    CreatorLocked,
    #[msg("Nothing to claim.")]
    NothingToClaim,
    #[msg("The curve does not hold enough SOL.")]
    InsufficientReserves,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("A Raydium account does not match the launchpad config.")]
    InvalidRaydiumAccount,
    #[msg("The fee recipient does not match the config.")]
    InvalidFeeRecipient,
    #[msg("The raised SOL does not cover the migration fee and pool costs.")]
    MigrationUnderfunded,
    #[msg("Only this token's creator can do this.")]
    NotCreator,
}
