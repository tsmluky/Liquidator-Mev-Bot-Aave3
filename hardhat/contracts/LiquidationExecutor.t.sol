// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationExecutor.sol";

contract LiquidationExecutorSmokeTest {
  function test_constructor_sets_owner_and_treasury() public {
    address aave = address(0x1111);
    address morpho = address(0x2222);
    address router = address(0x3333);
    address treasury = address(0xBEEF);

    LiquidationExecutor exec = new LiquidationExecutor(aave, morpho, router, treasury);

    require(exec.owner() == address(this), "owner not set");
    require(exec.treasury() == treasury, "treasury not set");
  }

  function test_constructor_reverts_on_zero_addresses() public {
    bool reverted;

    reverted = false;
    try new LiquidationExecutor(address(0), address(1), address(2), address(3)) { } catch { reverted = true; }
    require(reverted, "expected revert (aave=0)");

    reverted = false;
    try new LiquidationExecutor(address(1), address(0), address(2), address(3)) { } catch { reverted = true; }
    require(reverted, "expected revert (morpho=0)");

    reverted = false;
    try new LiquidationExecutor(address(1), address(2), address(0), address(3)) { } catch { reverted = true; }
    require(reverted, "expected revert (router=0)");

    reverted = false;
    try new LiquidationExecutor(address(1), address(2), address(3), address(0)) { } catch { reverted = true; }
    require(reverted, "expected revert (treasury=0)");
  }
}
