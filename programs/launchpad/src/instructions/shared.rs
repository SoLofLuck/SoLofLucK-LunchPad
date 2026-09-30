use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::SOL_VAULT_SEED;
use crate::errors::LaunchpadError;
use crate::math::Reserves;
use crate::state::BondingCurve;

impl BondingCurve {
    pub fn reserves(&self) -> Reserves {
        Reserves {
            virtual_sol: self.virtual_sol_reserves,
            virtual_token: self.virtual_token_reserves,
            real_sol: self.real_sol_reserves,
            real_token: self.real_token_reserves,
        }
    }

    pub fn set_reserves(&mut self, r: &Reserves) {
        self.virtual_sol_reserves = r.virtual_sol;
        self.virtual_token_reserves = r.virtual_token;
        self.real_sol_reserves = r.real_sol;
        self.real_token_reserves = r.real_token;
    }

    /// Lamports the SOL vault must hold: its rent minimum plus everything it
    /// owes.
    pub fn required_vault_lamports(&self) -> Result<u64> {
        Rent::get()?
            .minimum_balance(0)
            .checked_add(self.real_sol_reserves)
            .and_then(|v| v.checked_add(self.creator_fees_accrued))
            .and_then(|v| v.checked_add(self.protocol_fees_accrued))
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))
    }

    pub fn add_fees(&mut self, protocol: u64, creator: u64) -> Result<()> {
        self.protocol_fees_accrued = self
            .protocol_fees_accrued
            .checked_add(protocol)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        self.creator_fees_accrued = self
            .creator_fees_accrued
            .checked_add(creator)
            .ok_or_else(|| error!(LaunchpadError::MathOverflow))?;
        Ok(())
    }
}

/// Run after every SOL movement: the vault can never end up owing more than
/// it holds, whatever a bug elsewhere might try.
pub fn assert_solvent(curve: &BondingCurve, sol_vault: &AccountInfo) -> Result<()> {
    require!(
        sol_vault.lamports() >= curve.required_vault_lamports()?,
        LaunchpadError::InsufficientReserves
    );
    Ok(())
}

/// Pays `amount` lamports out of a token's SOL vault.
pub fn pay_from_vault<'info>(
    system_program: &AccountInfo<'info>,
    sol_vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    mint: &Pubkey,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            system_program::Transfer {
                from: sol_vault.clone(),
                to: to.clone(),
            },
            &[&[SOL_VAULT_SEED, mint.as_ref(), &[vault_bump]]],
        ),
        amount,
    )
}

/// Pays `amount` lamports from a signer into a token's SOL vault.
pub fn pay_into_vault<'info>(
    system_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    sol_vault: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            system_program::Transfer {
                from: from.clone(),
                to: sol_vault.clone(),
            },
        ),
        amount,
    )
}
