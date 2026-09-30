use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CURVE_SEED: &[u8] = b"curve";
/// A system-owned PDA per token that holds all of its SOL: the curve reserves
/// and both fee buckets. Because it is owned by the System Program, every SOL
/// movement is a plain System Program transfer, and it can act as the Raydium
/// pool creator (which must pay rent) at graduation.
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";

/// Every launchpad token has 6 decimals. The UI, the curve maths and the
/// Raydium price all assume it.
pub const TOKEN_DECIMALS: u8 = 6;

pub const BPS_DENOMINATOR: u64 = 10_000;
/// Hard ceiling on the trading fee (protocol + creator), whatever the admin
/// sets: 5%.
pub const MAX_TOTAL_FEE_BPS: u16 = 500;

/// Sell Lock durations a creator may pick, in seconds: none, 5 min, 15 min,
/// 1 h, 5 h, 24 h. A fixed list keeps the UI honest — a "lock" of 3 seconds
/// cannot be dressed up as protection.
pub const SELL_LOCK_OPTIONS: [i64; 6] = [0, 300, 900, 3_600, 18_000, 86_400];

/// Creator Lock durations for the creator's own initial buy: none, 1 day,
/// 7 days, 30 days, 90 days.
pub const CREATOR_LOCK_OPTIONS: [i64; 5] = [0, 86_400, 604_800, 2_592_000, 7_776_000];

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// Wrapped SOL, the quote side of every graduated pool.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// sha256("global:initialize")[..8] — the Raydium CPMM `initialize`
/// discriminator.
pub const CPMM_INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
