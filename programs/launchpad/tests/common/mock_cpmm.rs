//! A stand-in for Raydium CPMM's `initialize`, for tests only. It checks the
//! exact shape the real program expects (discriminator, 20 accounts in order,
//! creator and pool_state signing) and performs the same value movements:
//! the pool creation fee, rent for the pool state, both deposits, and LP
//! tokens minted to the creator's associated token account.
#![allow(deprecated)]

use solana_program_test::BanksClientError;
use solana_sdk::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::Instruction,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    system_instruction,
};

use super::{ata, token_2022, Env, MigrationAccounts};

pub const ID: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const AMM_CONFIG: Pubkey = pubkey!("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
pub const FEE_RECEIVER: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
pub const CREATE_POOL_FEE: u64 = 150_000_000;
pub const LP_LOCKED: u64 = 100;

pub fn authority() -> Pubkey {
    Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &ID).0
}

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn decimals(mint: &AccountInfo) -> u8 {
    mint.try_borrow_data().unwrap()[44]
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 32 || data[..8] != launchpad::constants::CPMM_INITIALIZE_DISCRIMINATOR {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 20 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let amount_0 = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let amount_1 = u64::from_le_bytes(data[16..24].try_into().unwrap());

    let creator = &accounts[0];
    let amm_config = &accounts[1];
    let auth = &accounts[2];
    let pool_state = &accounts[3];
    let mint_0 = &accounts[4];
    let mint_1 = &accounts[5];
    let lp_mint = &accounts[6];
    let user_0 = &accounts[7];
    let user_1 = &accounts[8];
    let user_lp = &accounts[9];
    let vault_0 = &accounts[10];
    let vault_1 = &accounts[11];
    let fee = &accounts[12];
    let token_program = &accounts[14];
    let program_0 = &accounts[15];
    let program_1 = &accounts[16];

    assert!(creator.is_signer, "creator must sign");
    assert!(creator.is_writable, "creator must be writable");
    assert!(
        pool_state.is_signer,
        "pool_state must sign (random keypair)"
    );
    assert_eq!(*amm_config.key, AMM_CONFIG);
    assert_eq!(*fee.key, FEE_RECEIVER);
    assert_eq!(*token_program.key, spl_token::ID);
    assert!(mint_0.key < mint_1.key, "mints must be sorted");
    let (auth_key, auth_bump) =
        Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], program_id);
    assert_eq!(*auth.key, auth_key);
    assert!(amount_0 > 0 && amount_1 > 0);

    // Pool creation fee.
    invoke(
        &system_instruction::transfer(creator.key, fee.key, CREATE_POOL_FEE),
        &[creator.clone(), fee.clone()],
    )?;
    // Pool state rent.
    let space = 637;
    invoke(
        &system_instruction::create_account(
            creator.key,
            pool_state.key,
            Rent::default().minimum_balance(space),
            space as u64,
            program_id,
        ),
        &[creator.clone(), pool_state.clone()],
    )?;
    // Deposits.
    for (program, user, vault, mint, amount) in [
        (program_0, user_0, vault_0, mint_0, amount_0),
        (program_1, user_1, vault_1, mint_1, amount_1),
    ] {
        invoke(
            &spl_token_2022::instruction::transfer_checked(
                program.key,
                user.key,
                mint.key,
                vault.key,
                creator.key,
                &[],
                amount,
                decimals(mint),
            )?,
            &[
                user.clone(),
                mint.clone(),
                vault.clone(),
                creator.clone(),
                program.clone(),
            ],
        )?;
    }
    // LP tokens to the creator's ATA (created here, paid by the creator).
    invoke(
        &spl_associated_token_account::instruction::create_associated_token_account(
            creator.key,
            creator.key,
            lp_mint.key,
            &spl_token::ID,
        ),
        &[
            creator.clone(),
            user_lp.clone(),
            lp_mint.clone(),
            accounts[18].clone(),
            token_program.clone(),
            accounts[17].clone(),
        ],
    )?;
    let liquidity = isqrt(amount_0 as u128 * amount_1 as u128) as u64;
    invoke_signed(
        &spl_token::instruction::mint_to(
            &spl_token::ID,
            lp_mint.key,
            user_lp.key,
            auth.key,
            &[],
            liquidity - LP_LOCKED,
        )?,
        &[lp_mint.clone(), user_lp.clone(), auth.clone()],
        &[&[b"vault_and_lp_mint_auth_seed", &[auth_bump]]],
    )?;
    Ok(())
}

/// Creates the LP mint and both vaults the mock expects.
pub async fn prepare(env: &mut Env, mint: &Pubkey) -> MigrationAccounts {
    let payer = env.ctx.payer.pubkey();
    let auth = authority();
    let wsol = spl_token::native_mint::ID;
    let mint_is_token_0 = *mint < wsol;
    let (m0, p0, m1, p1) = if mint_is_token_0 {
        (*mint, token_2022(), wsol, spl_token::ID)
    } else {
        (wsol, spl_token::ID, *mint, token_2022())
    };

    let lp_mint = Keypair::new();
    let rent = Rent::default();
    let ixs: Vec<Instruction> = vec![
        system_instruction::create_account(
            &payer,
            &lp_mint.pubkey(),
            rent.minimum_balance(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_mint2(&spl_token::ID, &lp_mint.pubkey(), &auth, None, 9)
            .unwrap(),
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &payer, &auth, &m0, &p0,
        ),
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &payer, &auth, &m1, &p1,
        ),
    ];
    let lp = lp_mint.insecure_clone();
    let res: Result<(), BanksClientError> = env.send(&ixs, &[&lp]).await;
    res.unwrap();
    MigrationAccounts {
        pool_state: Keypair::new(),
        lp_mint: lp_mint.pubkey(),
        vault_0: ata(&auth, &m0, &p0),
        vault_1: ata(&auth, &m1, &p1),
        mint_is_token_0,
    }
}
