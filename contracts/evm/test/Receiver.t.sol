// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Receiver} from "../src/Receiver.sol";

contract ReceiverTest is Test {
    function test_VersionIsSet() public {
        Receiver receiver = new Receiver();
        assertEq(receiver.VERSION(), "0.1.0");
    }
}
