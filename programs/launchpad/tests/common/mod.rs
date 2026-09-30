//! In-process test harness: solana-program-test runs the launchpad natively
//! alongside the real Token-2022 / SPL Token / ATA programs, so every test
//! exercises the real token logic without a validator or network.
#![allow(dead_code, deprecated)]

pub mod mock_cpmm;

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use launchpad::state::{BondingCurve, ConfigParams, GlobalConfig};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{Instruction, InstructionError},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::{Transaction, TransactionError},
};

pub const SOL: u64 = 1_000_000_000;
pub const TOK: u64 = 1_000_000;

pub fn entry_shim(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor's `entry` ties the slice and the AccountInfos to one lifetime;
    // solana-program-test gives them independent ones. Leak a copy.
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    launchpad::entry(program_id, accounts, data)
}

pub fn token_2022() -> Pubkey {
    spl_token_2022::ID
}

pub fn default_params() -> ConfigParams {
    ConfigParams {
        protocol_fee_bps: 70,
        creator_fee_bps: 30,
        token_total_supply: 1_000_000_000 * TOK,
        curve_token_supply: 793_100_000 * TOK,
        initial_virtual_token_reserves: 1_073_000_000 * TOK,
        initial_virtual_sol_reserves: 30 * SOL,
        migration_fee_lamports: SOL,
        pool_creation_budget_lamports: SOL / 2,
        raydium_cpmm_program: mock_cpmm::ID,
        raydium_amm_config: mock_cpmm::AMM_CONFIG,
        raydium_create_pool_fee: mock_cpmm::FEE_RECEIVER,
    }
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &launchpad::ID).0
}
pub fn curve_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"curve", mint.as_ref()], &launchpad::ID).0
}
pub fn sol_vault_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"sol_vault", mint.as_ref()], &launchpad::ID).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    spl_associated_token_account::get_associated_token_address_with_program_id(
        owner,
        mint,
        token_program,
    )
}

pub fn anchor_code(e: launchpad::errors::LaunchpadError) -> u32 {
    u32::from(e)
}

/// Asserts that a transaction failed with the given launchpad error.
pub fn assert_err(res: Result<(), BanksClientError>, expected: launchpad::errors::LaunchpadError) {
    let code = anchor_code(expected);
    match res {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            InstructionError::Custom(c),
        ))) if c == code => {}
        Err(BanksClientError::SimulationError {
            err: TransactionError::InstructionError(_, InstructionError::Custom(c)),
            ..
        }) if c == code => {}
        other => panic!("expected error {expected:?} ({code}), got {other:?}"),
    }
}

pub struct Env {
    pub ctx: ProgramTestContext,
    pub admin: Keypair,
    pub fee_recipient: Pubkey,
}

impl Env {
    pub async fn new() -> Self {
        Self::with_params(default_params()).await
    }

    pub async fn with_params(params: ConfigParams) -> Self {
        let mut pt = ProgramTest::new("launchpad", launchpad::ID, processor!(entry_shim));
        pt.add_program("mock_cpmm", mock_cpmm::ID, processor!(mock_cpmm::process));
        pt.prefer_bpf(false);

        // The native (wrapped SOL) mint.
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: None.into(),
            supply: 0,
            decimals: 9,
            is_initialized: true,
            freeze_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        pt.add_account(
            spl_token::native_mint::ID,
            Account {
                lamports: 1_461_600,
                data,
                owner: spl_token::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
        // Raydium's fee receiver must exist to receive lamports below the
        // rent-exempt minimum in some paths; give it a balance.
        pt.add_account(
            mock_cpmm::FEE_RECEIVER,
            Account::new(SOL, 0, &system_program::ID),
        );

        let ctx = pt.start_with_context().await;
        let admin = Keypair::new();
        let fee_recipient = Keypair::new().pubkey();
        let mut env = Env {
            ctx,
            admin,
            fee_recipient,
        };
        let admin_pk = env.admin.pubkey();
        env.airdrop(&admin_pk, 10 * SOL).await;
        env.airdrop(&fee_recipient, SOL).await;

        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::InitializeConfig {
                admin: admin_pk,
                config: config_pda(),
                program_data: Pubkey::new_unique(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::InitializeConfig {
                fee_recipient,
                params,
            }
            .data(),
        };
        let admin = env.admin.insecure_clone();
        env.send(&[ix], &[&admin]).await.unwrap();
        env
    }

    pub async fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        let payer = self.ctx.payer.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&payer];
        all.extend_from_slice(signers);
        let blockhash = self
            .ctx
            .banks_client
            .get_new_latest_blockhash(&self.ctx.last_blockhash)
            .await
            .unwrap();
        self.ctx.last_blockhash = blockhash;
        let mut ixs = ixs.to_vec();
        ixs.insert(
            0,
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        );
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &all, blockhash);
        self.ctx.banks_client.process_transaction(tx).await
    }

    pub async fn airdrop(&mut self, to: &Pubkey, lamports: u64) {
        let payer = self.ctx.payer.pubkey();
        self.send(&[system_instruction::transfer(&payer, to, lamports)], &[])
            .await
            .unwrap();
    }

    pub async fn user(&mut self, lamports: u64) -> Keypair {
        let kp = Keypair::new();
        self.airdrop(&kp.pubkey(), lamports).await;
        kp
    }

    pub async fn account(&mut self, key: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*key).await.unwrap()
    }

    pub async fn lamports(&mut self, key: &Pubkey) -> u64 {
        self.account(key).await.map(|a| a.lamports).unwrap_or(0)
    }

    pub async fn token_balance(&mut self, key: &Pubkey) -> u64 {
        match self.account(key).await {
            Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub async fn mint_supply(&mut self, mint: &Pubkey) -> u64 {
        let a = self.account(mint).await.unwrap();
        u64::from_le_bytes(a.data[36..44].try_into().unwrap())
    }

    pub async fn curve(&mut self, mint: &Pubkey) -> BondingCurve {
        let a = self.account(&curve_pda(mint)).await.unwrap();
        BondingCurve::try_deserialize(&mut &a.data[..]).unwrap()
    }

    pub async fn config(&mut self) -> GlobalConfig {
        let a = self.account(&config_pda()).await.unwrap();
        GlobalConfig::try_deserialize(&mut &a.data[..]).unwrap()
    }

    pub async fn now(&mut self) -> i64 {
        self.ctx
            .banks_client
            .get_sysvar::<Clock>()
            .await
            .unwrap()
            .unix_timestamp
    }

    pub async fn warp_seconds(&mut self, seconds: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp += seconds;
        self.ctx.set_sysvar(&clock);
    }

    // --- Instruction builders --------------------------------------------

    pub fn create_ix(
        &self,
        creator: &Pubkey,
        mint: &Pubkey,
        args: launchpad::instructions::CreateArgs,
    ) -> Instruction {
        let curve = curve_pda(mint);
        Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::Create {
                creator: *creator,
                config: config_pda(),
                mint: *mint,
                curve,
                sol_vault: sol_vault_pda(mint),
                curve_vault: ata(&curve, mint, &token_2022()),
                token_program: token_2022(),
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::Create { args }.data(),
        }
    }

    pub async fn create_token(
        &mut self,
        creator: &Keypair,
        sell_lock: i64,
        creator_lock: i64,
        initial_buy: u64,
    ) -> Result<Pubkey, BanksClientError> {
        let mint = Keypair::new();
        let ix = self.create_ix(
            &creator.pubkey(),
            &mint.pubkey(),
            args("Lucky Cat", "LCAT", sell_lock, creator_lock, initial_buy),
        );
        self.send(&[ix], &[creator, &mint]).await?;
        Ok(mint.pubkey())
    }

    pub fn buy_ix(
        &self,
        buyer: &Pubkey,
        mint: &Pubkey,
        max_cost: u64,
        min_out: u64,
    ) -> Instruction {
        let curve = curve_pda(mint);
        Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::Buy {
                buyer: *buyer,
                config: config_pda(),
                curve,
                sol_vault: sol_vault_pda(mint),
                mint: *mint,
                curve_vault: ata(&curve, mint, &token_2022()),
                buyer_token_account: ata(buyer, mint, &token_2022()),
                token_program: token_2022(),
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::Buy {
                max_sol_cost: max_cost,
                min_tokens_out: min_out,
            }
            .data(),
        }
    }

    pub async fn buy(
        &mut self,
        buyer: &Keypair,
        mint: &Pubkey,
        max_cost: u64,
        min_out: u64,
    ) -> Result<(), BanksClientError> {
        let ix = self.buy_ix(&buyer.pubkey(), mint, max_cost, min_out);
        self.send(&[ix], &[buyer]).await
    }

    pub async fn sell(
        &mut self,
        seller: &Keypair,
        mint: &Pubkey,
        amount: u64,
        min_out: u64,
    ) -> Result<(), BanksClientError> {
        let curve = curve_pda(mint);
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::Sell {
                seller: seller.pubkey(),
                curve,
                sol_vault: sol_vault_pda(mint),
                mint: *mint,
                curve_vault: ata(&curve, mint, &token_2022()),
                seller_token_account: ata(&seller.pubkey(), mint, &token_2022()),
                token_program: token_2022(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::Sell {
                token_amount: amount,
                min_sol_out: min_out,
            }
            .data(),
        };
        self.send(&[ix], &[seller]).await
    }

    pub async fn claim_creator_fees(
        &mut self,
        creator: &Keypair,
        mint: &Pubkey,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::ClaimCreatorFees {
                creator: creator.pubkey(),
                curve: curve_pda(mint),
                sol_vault: sol_vault_pda(mint),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::ClaimCreatorFees {}.data(),
        };
        self.send(&[ix], &[creator]).await
    }

    pub async fn collect_protocol_fees(
        &mut self,
        mint: &Pubkey,
        recipient: &Pubkey,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::CollectProtocolFees {
                config: config_pda(),
                curve: curve_pda(mint),
                sol_vault: sol_vault_pda(mint),
                fee_recipient: *recipient,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::CollectProtocolFees {}.data(),
        };
        self.send(&[ix], &[]).await
    }

    pub async fn claim_creator_lock(
        &mut self,
        creator: &Keypair,
        mint: &Pubkey,
    ) -> Result<(), BanksClientError> {
        let curve = curve_pda(mint);
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::ClaimCreatorLock {
                creator: creator.pubkey(),
                curve,
                mint: *mint,
                curve_vault: ata(&curve, mint, &token_2022()),
                creator_token_account: ata(&creator.pubkey(), mint, &token_2022()),
                token_program: token_2022(),
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::ClaimCreatorLock {}.data(),
        };
        self.send(&[ix], &[creator]).await
    }

    pub async fn admin_ix(
        &mut self,
        signer: &Keypair,
        data: Vec<u8>,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::AdminOnly {
                admin: signer.pubkey(),
                config: config_pda(),
            }
            .to_account_metas(None),
            data,
        };
        self.send(&[ix], &[signer]).await
    }

    /// Prepares the mock Raydium accounts and runs `migrate`.
    pub async fn migrate(&mut self, mint: &Pubkey) -> Result<MigrationAccounts, BanksClientError> {
        let m = mock_cpmm::prepare(self, mint).await;
        let curve = curve_pda(mint);
        let authority = sol_vault_pda(mint);
        let ix = Instruction {
            program_id: launchpad::ID,
            accounts: launchpad::accounts::Migrate {
                payer: self.ctx.payer.pubkey(),
                config: config_pda(),
                curve,
                mint: *mint,
                curve_vault: ata(&curve, mint, &token_2022()),
                sol_vault: authority,
                vault_token: ata(&authority, mint, &token_2022()),
                wsol_mint: spl_token::native_mint::ID,
                vault_wsol: ata(&authority, &spl_token::native_mint::ID, &spl_token::ID),
                fee_recipient: self.fee_recipient,
                cpmm_program: mock_cpmm::ID,
                amm_config: mock_cpmm::AMM_CONFIG,
                raydium_authority: mock_cpmm::authority(),
                pool_state: m.pool_state.pubkey(),
                lp_mint: m.lp_mint,
                vault_lp: ata(&authority, &m.lp_mint, &spl_token::ID),
                token_0_vault: m.vault_0,
                token_1_vault: m.vault_1,
                create_pool_fee: mock_cpmm::FEE_RECEIVER,
                observation_state: Pubkey::new_unique(),
                token_program: token_2022(),
                spl_token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
                rent: sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: launchpad::instruction::Migrate {}.data(),
        };
        let pool_state = m.pool_state.insecure_clone();
        self.send(&[ix], &[&pool_state]).await?;
        Ok(m)
    }
}

pub struct MigrationAccounts {
    pub pool_state: Keypair,
    pub lp_mint: Pubkey,
    pub vault_0: Pubkey,
    pub vault_1: Pubkey,
    pub mint_is_token_0: bool,
}

pub fn args(
    name: &str,
    symbol: &str,
    sell_lock: i64,
    creator_lock: i64,
    initial_buy: u64,
) -> launchpad::instructions::CreateArgs {
    launchpad::instructions::CreateArgs {
        name: name.to_string(),
        symbol: symbol.to_string(),
        uri: "https://gateway.pinata.cloud/ipfs/bafkreia".to_string(),
        sell_lock_seconds: sell_lock,
        creator_lock_seconds: creator_lock,
        initial_buy_lamports: initial_buy,
        min_tokens_out: 0,
    }
}
