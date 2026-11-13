// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Receiver} from "../src/Receiver.sol";

/// @notice Deploys the Receiver for one oracle and records it in
/// deployments/<chain id>.json. Run through scripts/deploy-receiver.sh, which
/// reads the oracle's derived address from NEAR.
///
/// Environment: ORACLE_EVM_ADDRESS (the oracle's derived EVM address),
/// ORACLE_ACCOUNT_ID (recorded only), EVM_PRIVATE_KEY (the deployer, never on
/// the command line).
contract DeployReceiver is Script {
    function run() external returns (Receiver receiver) {
        address oracle = vm.envAddress("ORACLE_EVM_ADDRESS");
        string memory oracleAccount = vm.envOr("ORACLE_ACCOUNT_ID", string(""));

        vm.startBroadcast(vm.envUint("EVM_PRIVATE_KEY"));
        receiver = new Receiver(oracle);
        vm.stopBroadcast();

        string memory record = "deployment";
        vm.serializeUint(record, "chain_id", block.chainid);
        vm.serializeAddress(record, "oracle_evm_address", oracle);
        vm.serializeString(record, "oracle", oracleAccount);
        vm.serializeUint(record, "block", block.number);
        string memory json = vm.serializeAddress(record, "receiver", address(receiver));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Receiver", address(receiver), "recorded in", path);
    }
}
