// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ExampleConsumer} from "../src/ExampleConsumer.sol";

/// @notice Deploys the example Consumer for a Receiver.
/// Environment: RECEIVER_ADDRESS, EVM_PRIVATE_KEY (never on the command line).
contract DeployExampleConsumer is Script {
    function run() external returns (ExampleConsumer consumer) {
        address receiver = vm.envAddress("RECEIVER_ADDRESS");
        vm.startBroadcast(vm.envUint("EVM_PRIVATE_KEY"));
        consumer = new ExampleConsumer(receiver);
        vm.stopBroadcast();
        console.log("ExampleConsumer", address(consumer), "for Receiver", receiver);
    }
}
