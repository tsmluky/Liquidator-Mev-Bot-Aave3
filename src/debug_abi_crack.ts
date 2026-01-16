import { toEventSelector } from "viem";

const TARGET_BORROW = "UNKNOWN"; // Need to find it. But wait, I didn't see a Borrow-like hash in the list?
// 0x00058... ? 0x804c... ?
// Let's assume one of the frequent ones is Borrow if people are borrowing.
// But Supply (0x2b62...) is definitely there.

const TARGET_SUPPLY = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
// 0xa534... is likely Repay or Withdraw?
const TARGET_REPAY = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";

// Let's try to find Borrow in the others.
// 0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a (12 occurrences - High frequency)
// 0xb3d084... (4 occurrences)

async function main() {
    console.log("Cracking ABI Signatures...");

    const variations = [
        // Supply Variations
        "Supply(address,address,address,uint256,uint16)",
        "Supply(address,address,address,uint256,uint256)",
        "Supply(address,address,uint256,uint16)",

        // Repay Variations
        "Repay(address,address,address,uint256,bool)",
        "Repay(address,address,address,uint256,uint256)",

        // Borrow Variations (Candidate for 0x804c...?)
        "Borrow(address,address,address,uint256,uint256,uint256,uint16)",
        "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
        "BorrowResult(address,address,address,uint256,uint256,uint256,uint16)", // Random guess

        // Let's check what 0x804c is
    ];

    // Helper to log hash
    const logHash = (sig: string) => {
        const hash = toEventSelector(sig);
        console.log(`${hash} : ${sig}`);
        if (hash === TARGET_SUPPLY) console.log(">>> MATCHED SUPPLY! <<<");
        if (hash === "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a") console.log(">>> MATCHED 0x804c (Likely Borrow?) <<<");
        if (hash === TARGET_REPAY) console.log(">>> MATCHED REPAY! <<<");
    };

    // Standard Aave V3 names, but maybe types differ
    // Aave V3 3.0 vs 3.1?

    // supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
    // Event: Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)
    // Canonical sig string: Supply(address,address,address,uint256,uint16) -> 0x2b62...

    // Maybe `user` is indexed? Supply(address,address,address,uint256,uint16) is same string regardless of indexed.
    // So the TYPES must allow for difference hash.
    // uint16 -> uint256?

    logHash("Supply(address,address,address,uint256,uint16)");
    logHash("Supply(address,address,address,uint256,uint256)"); // maybe referralCode is uint256?

    logHash("Repay(address,address,address,uint256,bool)");
    logHash("Repay(address,address,address,uint256,uint256)");

    // 0x804c... is actually `InterestCorrected(address,uint256)`? No.
    // Maybe `Withdraw(address,address,address,uint256)`?
    logHash("Withdraw(address,address,address,uint256)");

}

main();
