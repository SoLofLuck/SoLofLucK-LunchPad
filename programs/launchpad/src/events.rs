use anchor_lang::prelude::*;

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub sell_unlock_at: i64,
    pub creator_unlock_at: i64,
    pub timestamp: i64,
}

/// One per buy or sell. The UI rebuilds charts and the trade feed from these.
#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    /// SOL into the curve (buy) or out of it (sell), fees excluded.
    pub sol_amount: u64,
    pub token_amount: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub timestamp: i64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub real_sol_reserves: u64,
    pub timestamp: i64,
}

#[event]
pub struct Migrated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub sol_to_pool: u64,
    pub tokens_to_pool: u64,
    pub tokens_burned: u64,
    pub migration_fee: u64,
    pub timestamp: i64,
}

#[event]
pub struct CreatorFeesClaimed {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProtocolFeesCollected {
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CreatorLockClaimed {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}
