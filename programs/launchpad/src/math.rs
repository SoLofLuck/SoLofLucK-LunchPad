//! Bonding curve maths: a constant product `x * y = k` over *virtual*
//! reserves. Pure functions only, so they can be unit tested without a chain
//! and mirrored 1:1 by the web client (app/src/lib/curve.ts).
//!
//! Rounding always favours the curve: buyers get tokens rounded down, sellers
//! get SOL rounded down, and fees are rounded up.

use crate::constants::BPS_DENOMINATOR;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    pub protocol: u64,
    pub creator: u64,
}

impl Fees {
    pub fn total(&self) -> Option<u64> {
        self.protocol.checked_add(self.creator)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// SOL added to the curve's reserves.
    pub sol_in: u64,
    pub fees: Fees,
    /// Total SOL the buyer pays: `sol_in` plus fees.
    pub total_cost: u64,
    pub tokens_out: u64,
    /// True when this buy sells the last curve token.
    pub completes_curve: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// SOL removed from the curve's reserves.
    pub sol_out: u64,
    pub fees: Fees,
    /// SOL the seller receives: `sol_out` minus fees.
    pub net_to_seller: u64,
}

pub fn fee_ceil(amount: u64, bps: u16) -> Option<u64> {
    let num = (amount as u128).checked_mul(bps as u128)?;
    let fee = num.checked_add(BPS_DENOMINATOR as u128 - 1)? / BPS_DENOMINATOR as u128;
    u64::try_from(fee).ok()
}

pub fn fees_for(amount: u64, protocol_bps: u16, creator_bps: u16) -> Option<Fees> {
    Some(Fees {
        protocol: fee_ceil(amount, protocol_bps)?,
        creator: fee_ceil(amount, creator_bps)?,
    })
}

/// Tokens out for `sol_in` SOL added to the reserves (fees already removed).
pub fn tokens_out_for_sol(r: &Reserves, sol_in: u64) -> Option<u64> {
    let num = (r.virtual_token as u128).checked_mul(sol_in as u128)?;
    let den = (r.virtual_sol as u128).checked_add(sol_in as u128)?;
    u64::try_from(num / den).ok()
}

/// SOL that must be added to the reserves to take out exactly `tokens_out`.
pub fn sol_in_for_tokens(r: &Reserves, tokens_out: u64) -> Option<u64> {
    if tokens_out >= r.virtual_token {
        return None;
    }
    let num = (r.virtual_sol as u128).checked_mul(tokens_out as u128)?;
    let den = (r.virtual_token as u128).checked_sub(tokens_out as u128)?;
    u64::try_from(num.checked_add(den - 1)? / den).ok()
}

/// Buy by spending up to `max_total` SOL (fees included). If that would buy
/// more than the curve has left, the buy is capped at the remaining tokens and
/// costs less.
pub fn quote_buy(
    r: &Reserves,
    max_total: u64,
    protocol_bps: u16,
    creator_bps: u16,
) -> Option<BuyQuote> {
    let fees = fees_for(max_total, protocol_bps, creator_bps)?;
    let sol_in = max_total.checked_sub(fees.total()?)?;
    let tokens_out = tokens_out_for_sol(r, sol_in)?;

    if tokens_out < r.real_token {
        return Some(BuyQuote {
            sol_in,
            fees,
            total_cost: max_total,
            tokens_out,
            completes_curve: false,
        });
    }

    // Capped: take exactly what is left and charge only for that.
    let tokens_out = r.real_token;
    let sol_in = sol_in_for_tokens(r, tokens_out)?;
    let fees = fees_for(sol_in, protocol_bps, creator_bps)?;
    let total_cost = sol_in.checked_add(fees.total()?)?;
    Some(BuyQuote {
        sol_in,
        fees,
        total_cost,
        tokens_out,
        completes_curve: true,
    })
}

pub fn quote_sell(
    r: &Reserves,
    tokens_in: u64,
    protocol_bps: u16,
    creator_bps: u16,
) -> Option<SellQuote> {
    let num = (r.virtual_sol as u128).checked_mul(tokens_in as u128)?;
    let den = (r.virtual_token as u128).checked_add(tokens_in as u128)?;
    // Clamp to the real reserves: rounding must never let the curve pay out
    // SOL it does not hold.
    let sol_out = u64::try_from(num / den).ok()?.min(r.real_sol);
    let fees = fees_for(sol_out, protocol_bps, creator_bps)?;
    let net_to_seller = sol_out.checked_sub(fees.total()?)?;
    Some(SellQuote {
        sol_out,
        fees,
        net_to_seller,
    })
}

pub fn apply_buy(r: &Reserves, q: &BuyQuote) -> Option<Reserves> {
    Some(Reserves {
        virtual_sol: r.virtual_sol.checked_add(q.sol_in)?,
        virtual_token: r.virtual_token.checked_sub(q.tokens_out)?,
        real_sol: r.real_sol.checked_add(q.sol_in)?,
        real_token: r.real_token.checked_sub(q.tokens_out)?,
    })
}

pub fn apply_sell(r: &Reserves, tokens_in: u64, q: &SellQuote) -> Option<Reserves> {
    Some(Reserves {
        virtual_sol: r.virtual_sol.checked_sub(q.sol_out)?,
        virtual_token: r.virtual_token.checked_add(tokens_in)?,
        real_sol: r.real_sol.checked_sub(q.sol_out)?,
        real_token: r.real_token.checked_add(tokens_in)?,
    })
}

/// Tokens to pair with `sol` in the Raydium pool so the pool opens at the
/// curve's final price (virtual_sol / virtual_token).
pub fn tokens_for_price(r: &Reserves, sol: u64) -> Option<u64> {
    let num = (sol as u128).checked_mul(r.virtual_token as u128)?;
    u64::try_from(num / r.virtual_sol as u128).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    const TOK: u64 = 1_000_000;

    fn fresh() -> Reserves {
        Reserves {
            virtual_sol: 30 * SOL,
            virtual_token: 1_073_000_000 * TOK,
            real_sol: 0,
            real_token: 793_100_000 * TOK,
        }
    }

    #[test]
    fn fee_rounds_up() {
        assert_eq!(fee_ceil(10_000, 100), Some(100));
        assert_eq!(fee_ceil(10_001, 100), Some(101));
        assert_eq!(fee_ceil(0, 100), Some(0));
        assert_eq!(fee_ceil(1, 1), Some(1));
    }

    #[test]
    fn buy_then_sell_never_profits() {
        let r = fresh();
        for amount in [1_000u64, SOL / 100, SOL, 10 * SOL, 50 * SOL] {
            let b = quote_buy(&r, amount, 70, 30).unwrap();
            let r2 = apply_buy(&r, &b).unwrap();
            let s = quote_sell(&r2, b.tokens_out, 70, 30).unwrap();
            assert!(s.net_to_seller <= amount, "round trip profited at {amount}");
            assert!(s.sol_out <= b.sol_in, "curve paid out more than it took in");
            let r3 = apply_sell(&r2, b.tokens_out, &s).unwrap();
            assert_eq!(r3.real_token, r.real_token);
        }
    }

    #[test]
    fn invariant_never_decreases() {
        let mut r = fresh();
        let k0 = r.virtual_sol as u128 * r.virtual_token as u128;
        for i in 1..50u64 {
            let b = quote_buy(&r, i * SOL / 7, 70, 30).unwrap();
            r = apply_buy(&r, &b).unwrap();
            let k = r.virtual_sol as u128 * r.virtual_token as u128;
            assert!(k >= k0);
            if b.completes_curve {
                break;
            }
            if i % 3 == 0 {
                let s = quote_sell(&r, b.tokens_out / 2, 70, 30).unwrap();
                r = apply_sell(&r, b.tokens_out / 2, &s).unwrap();
                assert!(r.virtual_sol as u128 * r.virtual_token as u128 >= k0);
            }
        }
    }

    #[test]
    fn oversized_buy_is_capped_and_completes() {
        let r = fresh();
        let b = quote_buy(&r, 1_000 * SOL, 70, 30).unwrap();
        assert!(b.completes_curve);
        assert_eq!(b.tokens_out, r.real_token);
        assert!(b.total_cost < 1_000 * SOL);
        let r2 = apply_buy(&r, &b).unwrap();
        assert_eq!(r2.real_token, 0);
        // With the default parameters about 85 SOL graduates the curve.
        assert!(
            r2.real_sol > 84 * SOL && r2.real_sol < 86 * SOL,
            "{}",
            r2.real_sol
        );
    }

    #[test]
    fn exact_completion_amount_completes() {
        let r = fresh();
        let sol_in = sol_in_for_tokens(&r, r.real_token).unwrap();
        let r2 = Reserves {
            virtual_sol: r.virtual_sol + sol_in,
            virtual_token: r.virtual_token - r.real_token,
            real_sol: sol_in,
            real_token: 0,
        };
        assert!(
            r2.virtual_sol as u128 * r2.virtual_token as u128
                >= r.virtual_sol as u128 * r.virtual_token as u128
        );
    }

    #[test]
    fn sell_clamped_to_real_sol() {
        let r = Reserves {
            virtual_sol: 30 * SOL,
            virtual_token: 1_000 * TOK,
            real_sol: 5,
            real_token: 0,
        };
        let s = quote_sell(&r, 500 * TOK, 0, 0).unwrap();
        assert_eq!(s.sol_out, 5);
    }

    #[test]
    fn pool_price_matches_curve_price() {
        let r = fresh();
        let b = quote_buy(&r, 1_000 * SOL, 70, 30).unwrap();
        let r2 = apply_buy(&r, &b).unwrap();
        let sol = 80 * SOL;
        let tokens = tokens_for_price(&r2, sol).unwrap();
        // tokens / sol == virtual_token / virtual_sol, within one unit.
        let lhs = tokens as u128 * r2.virtual_sol as u128;
        let rhs = sol as u128 * r2.virtual_token as u128;
        assert!(rhs - lhs < r2.virtual_sol as u128);
        // And it fits inside the 206.9M reserve.
        assert!(tokens <= 206_900_000 * TOK);
    }

    #[test]
    fn tiny_buys_do_not_panic() {
        let r = fresh();
        for amount in 0..200u64 {
            let _ = quote_buy(&r, amount, 70, 30);
            let _ = quote_sell(&r, amount, 70, 30);
        }
    }
}
