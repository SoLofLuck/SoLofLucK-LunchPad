mod common;

use anchor_lang::InstructionData;
use common::*;
use launchpad::errors::LaunchpadError;
use launchpad::state::CurveStatus;
use solana_sdk::{
    rent::Rent,
    signature::{Keypair, Signer},
};

fn rent_for(len: usize) -> u64 {
    Rent::default().minimum_balance(len)
}

/// The SOL vault must always hold its rent minimum + real SOL + both fee
/// buckets.
async fn assert_curve_solvent(env: &mut Env, mint: &solana_sdk::pubkey::Pubkey) {
    let c = env.curve(mint).await;
    let held = env.lamports(&sol_vault_pda(mint)).await;
    let need = rent_for(0) + c.real_sol_reserves + c.creator_fees_accrued + c.protocol_fees_accrued;
    assert!(held >= need, "vault insolvent: {held} < {need}");
}

#[tokio::test]
async fn create_mints_full_supply_and_revokes_authorities() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let mint = env.create_token(&creator, 900, 0, 0).await.unwrap();

    let curve = env.curve(&mint).await;
    assert_eq!(curve.status, CurveStatus::Trading);
    assert_eq!(curve.creator, creator.pubkey());
    assert_eq!(curve.real_token_reserves, 793_100_000 * TOK);
    assert_eq!(curve.lp_token_reserve, 206_900_000 * TOK);
    assert_eq!(curve.sell_unlock_at - curve.created_at, 900);

    let vault = ata(&curve_pda(&mint), &mint, &token_2022());
    assert_eq!(env.token_balance(&vault).await, 1_000_000_000 * TOK);
    assert_eq!(env.mint_supply(&mint).await, 1_000_000_000 * TOK);

    let mint_acc = env.account(&mint).await.unwrap();
    assert_eq!(mint_acc.owner, token_2022());
    // COption tags: mint authority (bytes 0..4) and freeze authority (46..50) are None.
    assert_eq!(
        &mint_acc.data[0..4],
        &[0, 0, 0, 0],
        "mint authority must be revoked"
    );
    assert_eq!(&mint_acc.data[46..50], &[0, 0, 0, 0], "no freeze authority");
    // Metadata lives in the mint.
    let hay = &mint_acc.data;
    assert!(
        hay.windows(9).any(|w| w == b"Lucky Cat"),
        "name missing from metadata"
    );
    assert!(
        hay.windows(4).any(|w| w == b"LCAT"),
        "symbol missing from metadata"
    );
}

#[tokio::test]
async fn create_rejects_bad_arguments() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;

    for (a, err) in [
        (args("x", "X", 1234, 0, 0), LaunchpadError::InvalidSellLock),
        (args("x", "X", 0, 5, 0), LaunchpadError::InvalidCreatorLock),
        (args("", "X", 0, 0, 0), LaunchpadError::InvalidMetadata),
        (
            args(&"n".repeat(33), "X", 0, 0, 0),
            LaunchpadError::InvalidMetadata,
        ),
        (
            args("x", "SYMBOLTOOLONG", 0, 0, 0),
            LaunchpadError::InvalidMetadata,
        ),
    ] {
        let mint = Keypair::new();
        let ix = env.create_ix(&creator.pubkey(), &mint.pubkey(), a);
        assert_err(env.send(&[ix], &[&creator, &mint]).await, err);
    }
}

#[tokio::test]
async fn sell_lock_blocks_sells_until_expiry_but_never_buys() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let alice = env.user(20 * SOL).await;
    let mint = env.create_token(&creator, 3_600, 0, 0).await.unwrap();

    env.buy(&alice, &mint, SOL, 1).await.unwrap();
    let alice_ata = ata(&alice.pubkey(), &mint, &token_2022());
    let bought = env.token_balance(&alice_ata).await;
    assert!(
        bought > 30_000_000 * TOK && bought < 40_000_000 * TOK,
        "{bought}"
    );

    assert_err(
        env.sell(&alice, &mint, bought / 2, 0).await,
        LaunchpadError::SellLocked,
    );

    env.warp_seconds(3_599).await;
    assert_err(
        env.sell(&alice, &mint, bought / 2, 0).await,
        LaunchpadError::SellLocked,
    );
    // Buying stays open throughout.
    env.buy(&alice, &mint, SOL / 10, 1).await.unwrap();

    env.warp_seconds(1).await;
    let before = env.lamports(&alice.pubkey()).await;
    env.sell(&alice, &mint, bought / 2, 1).await.unwrap();
    assert!(env.lamports(&alice.pubkey()).await > before);
    assert_curve_solvent(&mut env, &mint).await;
}

#[tokio::test]
async fn buy_and_sell_accounting_and_slippage() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let alice = env.user(20 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();

    // Slippage: asking for more tokens than 1 SOL buys fails.
    assert_err(
        env.buy(&alice, &mint, SOL, 1_000_000_000 * TOK).await,
        LaunchpadError::SlippageExceeded,
    );
    assert_err(
        env.buy(&alice, &mint, 0, 0).await,
        LaunchpadError::ZeroAmount,
    );

    let vault_key = sol_vault_pda(&mint);
    let vault_before = env.lamports(&vault_key).await;
    env.buy(&alice, &mint, SOL, 1).await.unwrap();
    let c = env.curve(&mint).await;
    // 1% fee: 0.7% protocol, 0.3% creator.
    assert_eq!(c.protocol_fees_accrued, 7_000_000);
    assert_eq!(c.creator_fees_accrued, 3_000_000);
    assert_eq!(c.real_sol_reserves, SOL - 10_000_000);
    assert_eq!(env.lamports(&vault_key).await - vault_before, SOL);

    let alice_ata = ata(&alice.pubkey(), &mint, &token_2022());
    let tokens = env.token_balance(&alice_ata).await;
    assert_eq!(c.real_token_reserves, 793_100_000 * TOK - tokens);

    // Selling everything back returns less than was paid (fees both ways).
    assert_err(
        env.sell(&alice, &mint, tokens, SOL).await,
        LaunchpadError::SlippageExceeded,
    );
    let before = env.lamports(&alice.pubkey()).await;
    env.sell(&alice, &mint, tokens, 1).await.unwrap();
    let got = env.lamports(&alice.pubkey()).await - before;
    assert!(got < SOL && got > 97 * SOL / 100, "{got}");
    let c = env.curve(&mint).await;
    assert_eq!(c.real_token_reserves, 793_100_000 * TOK);
    assert!(
        c.real_sol_reserves <= 1,
        "dust left: {}",
        c.real_sol_reserves
    );
    assert_curve_solvent(&mut env, &mint).await;

    // Selling tokens you don't have fails in the token program.
    assert!(env.sell(&alice, &mint, 1, 0).await.is_err());
}

#[tokio::test]
async fn creator_lock_holds_initial_buy() {
    let mut env = Env::new().await;
    let creator = env.user(20 * SOL).await;
    let mint = env
        .create_token(&creator, 0, 86_400, 2 * SOL)
        .await
        .unwrap();

    let c = env.curve(&mint).await;
    assert!(c.creator_locked_tokens > 0);
    assert_eq!(
        c.real_token_reserves,
        793_100_000 * TOK - c.creator_locked_tokens
    );
    let creator_ata = ata(&creator.pubkey(), &mint, &token_2022());
    assert_eq!(env.token_balance(&creator_ata).await, 0);

    assert_err(
        env.claim_creator_lock(&creator, &mint).await,
        LaunchpadError::CreatorLocked,
    );
    let stranger = env.user(SOL).await;
    assert!(env.claim_creator_lock(&stranger, &mint).await.is_err());

    env.warp_seconds(86_400).await;
    env.claim_creator_lock(&creator, &mint).await.unwrap();
    assert_eq!(
        env.token_balance(&creator_ata).await,
        c.creator_locked_tokens
    );
    assert_err(
        env.claim_creator_lock(&creator, &mint).await,
        LaunchpadError::NothingToClaim,
    );
}

#[tokio::test]
async fn fees_are_claimable_by_the_right_parties_only() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let alice = env.user(20 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();
    env.buy(&alice, &mint, 10 * SOL, 1).await.unwrap();

    assert_err(
        env.claim_creator_fees(&alice, &mint).await,
        LaunchpadError::NotCreator,
    );

    let before = env.lamports(&creator.pubkey()).await;
    env.claim_creator_fees(&creator, &mint).await.unwrap();
    // Minus the transaction fee, paid by the harness payer, so exact.
    assert_eq!(env.lamports(&creator.pubkey()).await - before, 30_000_000);
    assert_err(
        env.claim_creator_fees(&creator, &mint).await,
        LaunchpadError::NothingToClaim,
    );

    let wrong = Keypair::new().pubkey();
    assert_err(
        env.collect_protocol_fees(&mint, &wrong).await,
        LaunchpadError::InvalidFeeRecipient,
    );
    let recipient = env.fee_recipient;
    let before = env.lamports(&recipient).await;
    env.collect_protocol_fees(&mint, &recipient).await.unwrap();
    assert_eq!(env.lamports(&recipient).await - before, 70_000_000);
    assert_curve_solvent(&mut env, &mint).await;
}

#[tokio::test]
async fn pause_blocks_create_and_buy_but_never_sell() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let alice = env.user(20 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();
    env.buy(&alice, &mint, SOL, 1).await.unwrap();

    let stranger = env.user(SOL).await;
    assert_err(
        env.admin_ix(
            &stranger,
            launchpad::instruction::SetPaused { paused: true }.data(),
        )
        .await,
        LaunchpadError::NotAdmin,
    );
    let admin = env.admin.insecure_clone();
    env.admin_ix(
        &admin,
        launchpad::instruction::SetPaused { paused: true }.data(),
    )
    .await
    .unwrap();

    assert_err(env.buy(&alice, &mint, SOL, 1).await, LaunchpadError::Paused);
    assert_err(
        env.create_token(&creator, 0, 0, 0).await.map(|_| ()),
        LaunchpadError::Paused,
    );
    let tokens = env
        .token_balance(&ata(&alice.pubkey(), &mint, &token_2022()))
        .await;
    env.sell(&alice, &mint, tokens, 1).await.unwrap();

    env.admin_ix(
        &admin,
        launchpad::instruction::SetPaused { paused: false }.data(),
    )
    .await
    .unwrap();
    env.buy(&alice, &mint, SOL, 1).await.unwrap();
}

#[tokio::test]
async fn admin_handover_and_param_validation() {
    let mut env = Env::new().await;
    let admin = env.admin.insecure_clone();

    let mut bad = default_params();
    bad.protocol_fee_bps = 400;
    bad.creator_fee_bps = 101;
    assert_err(
        env.admin_ix(
            &admin,
            launchpad::instruction::UpdateConfig { params: bad }.data(),
        )
        .await,
        LaunchpadError::InvalidConfig,
    );
    let mut bad = default_params();
    bad.initial_virtual_token_reserves = bad.curve_token_supply;
    assert_err(
        env.admin_ix(
            &admin,
            launchpad::instruction::UpdateConfig { params: bad }.data(),
        )
        .await,
        LaunchpadError::InvalidConfig,
    );

    // Config changes do not touch existing curves.
    let creator = env.user(10 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();
    let mut p = default_params();
    p.protocol_fee_bps = 200;
    env.admin_ix(
        &admin,
        launchpad::instruction::UpdateConfig { params: p }.data(),
    )
    .await
    .unwrap();
    assert_eq!(env.curve(&mint).await.protocol_fee_bps, 70);

    let next = env.user(SOL).await;
    env.admin_ix(
        &admin,
        launchpad::instruction::TransferAdmin {
            new_admin: next.pubkey(),
        }
        .data(),
    )
    .await
    .unwrap();
    // The old admin keeps control until the handover is accepted.
    assert_eq!(env.config().await.admin, admin.pubkey());

    let impostor = env.user(SOL).await;
    let accept = |who: &Keypair| solana_sdk::instruction::Instruction {
        program_id: launchpad::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &launchpad::accounts::AcceptAdmin {
                new_admin: who.pubkey(),
                config: config_pda(),
            },
            None,
        ),
        data: launchpad::instruction::AcceptAdmin {}.data(),
    };
    assert_err(
        env.send(&[accept(&impostor)], &[&impostor]).await,
        LaunchpadError::NotPendingAdmin,
    );
    env.send(&[accept(&next)], &[&next]).await.unwrap();
    let cfg = env.config().await;
    assert_eq!(cfg.admin, next.pubkey());
    assert_eq!(cfg.pending_admin, solana_sdk::pubkey::Pubkey::default());
    assert_err(
        env.admin_ix(
            &admin,
            launchpad::instruction::SetPaused { paused: true }.data(),
        )
        .await,
        LaunchpadError::NotAdmin,
    );
}

#[tokio::test]
async fn completion_and_migration_to_raydium() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let whale = env.user(200 * SOL).await;
    let alice = env.user(10 * SOL).await;
    let mint = env.create_token(&creator, 300, 0, 0).await.unwrap();

    assert_err(
        env.migrate(&mint).await.map(|_| ()),
        LaunchpadError::CurveNotComplete,
    );

    // One oversized buy takes the rest of the curve and pays only for that.
    let before = env.lamports(&whale.pubkey()).await;
    env.buy(&whale, &mint, 150 * SOL, 1).await.unwrap();
    let spent = before - env.lamports(&whale.pubkey()).await;
    assert!(spent < 90 * SOL, "overcharged: {spent}");
    let c = env.curve(&mint).await;
    assert_eq!(c.status, CurveStatus::Complete);
    assert_eq!(c.real_token_reserves, 0);
    assert_eq!(
        env.token_balance(&ata(&whale.pubkey(), &mint, &token_2022()))
            .await,
        793_100_000 * TOK
    );

    // Trading on the curve is over.
    assert_err(
        env.buy(&alice, &mint, SOL, 1).await,
        LaunchpadError::CurveComplete,
    );
    env.warp_seconds(300).await;
    assert_err(
        env.sell(&whale, &mint, TOK, 0).await,
        LaunchpadError::CurveComplete,
    );

    // Graduation still waits for the Sell Lock... (reset clock by creating a
    // new locked token would be slower; the lock above already expired.)
    let raised = c.real_sol_reserves;
    let fee_before = env.lamports(&env.fee_recipient.clone()).await;
    let supply_before = env.mint_supply(&mint).await;
    let m = env.migrate(&mint).await.unwrap();

    let c = env.curve(&mint).await;
    assert_eq!(c.status, CurveStatus::Migrated);
    assert_eq!(c.raydium_pool, m.pool_state.pubkey());
    assert_eq!(c.real_sol_reserves, 0);
    assert_eq!(c.lp_token_reserve, 0);

    let sol_to_pool = raised - SOL - SOL / 2;
    let (token_vault, sol_vault) = if m.mint_is_token_0 {
        (m.vault_0, m.vault_1)
    } else {
        (m.vault_1, m.vault_0)
    };
    let tokens_in_pool = env.token_balance(&token_vault).await;
    assert_eq!(env.token_balance(&sol_vault).await, sol_to_pool);
    // Pool price == final curve price.
    let lhs = tokens_in_pool as u128 * c.virtual_sol_reserves as u128;
    let rhs = sol_to_pool as u128 * c.virtual_token_reserves as u128;
    assert!(rhs >= lhs && rhs - lhs < c.virtual_sol_reserves as u128);

    // Unneeded reserve burned; nothing left in the curve vault.
    let burned = supply_before - env.mint_supply(&mint).await;
    assert_eq!(burned, 206_900_000 * TOK - tokens_in_pool);
    assert_eq!(
        env.token_balance(&ata(&curve_pda(&mint), &mint, &token_2022()))
            .await,
        0
    );

    // Every LP token was burned.
    let authority = sol_vault_pda(&mint);
    assert_eq!(
        env.token_balance(&ata(&authority, &m.lp_mint, &spl_token::ID))
            .await,
        0
    );
    assert_eq!(env.mint_supply(&m.lp_mint).await, 0);
    // Temporary accounts closed, budget leftover swept to the fee recipient.
    assert!(env
        .account(&ata(&authority, &mint, &token_2022()))
        .await
        .is_none());
    assert!(env
        .account(&ata(
            &authority,
            &spl_token::native_mint::ID,
            &spl_token::ID
        ))
        .await
        .is_none());
    // The vault keeps exactly its rent minimum plus the fees it owes.
    assert_eq!(
        env.lamports(&authority).await,
        rent_for(0) + c.protocol_fees_accrued + c.creator_fees_accrued
    );
    let fee_after = env.lamports(&env.fee_recipient.clone()).await;
    assert!(fee_after > fee_before, "leftover budget not swept");
    // Migration fee is accrued for collection, alongside trading fees.
    assert!(c.protocol_fees_accrued >= SOL);
    assert_curve_solvent(&mut env, &mint).await;

    assert_err(
        env.migrate(&mint).await.map(|_| ()),
        LaunchpadError::AlreadyMigrated,
    );
    // Fees remain claimable after graduation.
    env.claim_creator_fees(&creator, &mint).await.unwrap();
    let recipient = env.fee_recipient;
    env.collect_protocol_fees(&mint, &recipient).await.unwrap();
    assert_curve_solvent(&mut env, &mint).await;
}

#[tokio::test]
async fn migration_waits_for_sell_lock() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let whale = env.user(200 * SOL).await;
    let mint = env.create_token(&creator, 86_400, 0, 0).await.unwrap();
    env.buy(&whale, &mint, 150 * SOL, 1).await.unwrap();
    assert_err(
        env.migrate(&mint).await.map(|_| ()),
        LaunchpadError::SellLocked,
    );
    env.warp_seconds(86_400).await;
    env.migrate(&mint).await.unwrap();
}

#[tokio::test]
async fn migration_rejects_foreign_raydium_accounts() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let whale = env.user(200 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();
    env.buy(&whale, &mint, 150 * SOL, 1).await.unwrap();

    // Point the config at a different CPMM program: the call must refuse the
    // mock now.
    let admin = env.admin.insecure_clone();
    let mut p = default_params();
    p.raydium_cpmm_program = solana_sdk::pubkey::Pubkey::new_unique();
    env.admin_ix(
        &admin,
        launchpad::instruction::UpdateConfig { params: p }.data(),
    )
    .await
    .unwrap();
    assert_err(
        env.migrate(&mint).await.map(|_| ()),
        LaunchpadError::InvalidRaydiumAccount,
    );
}

/// Many users buying and selling in random-ish order: the curve always stays
/// solvent, and once everyone has sold, all that is left is fees + dust.
#[tokio::test]
async fn solvency_under_many_trades() {
    let mut env = Env::new().await;
    let creator = env.user(10 * SOL).await;
    let mint = env.create_token(&creator, 0, 0, 0).await.unwrap();
    let mut users = Vec::new();
    for _ in 0..5 {
        users.push(env.user(30 * SOL).await);
    }
    let mut seed: u64 = 0x5eed;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..40 {
        let u = &users[(next() % 5) as usize];
        let u = u.insecure_clone();
        if next() % 3 == 0 {
            let bal = env
                .token_balance(&ata(&u.pubkey(), &mint, &token_2022()))
                .await;
            if bal > 0 {
                let amt = 1 + next() % bal;
                env.sell(&u, &mint, amt, 0).await.unwrap();
            }
        } else {
            let amt = SOL / 100 + next() % (3 * SOL);
            env.buy(&u, &mint, amt, 1).await.unwrap();
        }
        assert_curve_solvent(&mut env, &mint).await;
    }
    for u in &users {
        let u = u.insecure_clone();
        let bal = env
            .token_balance(&ata(&u.pubkey(), &mint, &token_2022()))
            .await;
        if bal > 0 {
            env.sell(&u, &mint, bal, 0).await.unwrap();
        }
    }
    let c = env.curve(&mint).await;
    assert_eq!(c.real_token_reserves, 793_100_000 * TOK);
    assert!(
        c.real_sol_reserves < 100,
        "residual {}",
        c.real_sol_reserves
    );
    assert_eq!(c.virtual_token_reserves, 1_073_000_000 * TOK);
    assert_curve_solvent(&mut env, &mint).await;
}
