// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice Deploys the demo escrow for a Receiver.
///
/// Environment:
///   RECEIVER_ADDRESS  the Enzure Receiver on this chain
///   EVM_PRIVATE_KEY   the deployer (never on the command line)
///   USDC_ADDRESS      the token; leave it unset to deploy TestUSDC instead and
///                     mint TEST_USDC_MINT (default 1000 tUSDC) to the deployer
contract DeployEscrow is Script {
    function run() external returns (Escrow escrow) {
        address receiver = vm.envAddress("RECEIVER_ADDRESS");
        address token = vm.envOr("USDC_ADDRESS", address(0));

        vm.startBroadcast(vm.envUint("EVM_PRIVATE_KEY"));
        if (token == address(0)) {
            TestUSDC testUsdc = new TestUSDC();
            testUsdc.mint(msg.sender, vm.envOr("TEST_USDC_MINT", uint256(1000e6)));
            token = address(testUsdc);
        }
        escrow = new Escrow(token, receiver);
        vm.stopBroadcast();
        console.log("Escrow", address(escrow), "token", token);
    }
}
