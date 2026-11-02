const fs = require("fs");
const path = require("path");
const solc = require("solc");
function compile() {
  const dir = "/home/claude/ref/XDPoSChain/contracts/validator/contract";
  const sources = {
    "XDCValidator.sol": fs.readFileSync(dir + "/XDCValidator.sol", "utf8"),
    "Tok.sol": `pragma solidity ^0.4.24;
contract Tok { string public name = "Test Token"; string public symbol = "TKN"; uint8 public decimals = 6;
  mapping(address => uint256) public balanceOf; event Transfer(address indexed f, address indexed t, uint256 v);
  constructor(address a, uint256 v) public { balanceOf[a] = v; }
  function transfer(address to, uint256 v) public returns (bool) { require(balanceOf[msg.sender] >= v); balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; } }`,
  };
  const out = solc.compile({ sources }, 1, (p) => ({ contents: fs.readFileSync(path.join(dir, p.replace(/^\.\//, "")), "utf8") }));
  const get = (k) => { const c = Object.entries(out.contracts).find(([n]) => n.endsWith(k))[1]; return { abi: JSON.parse(c.interface), bytecode: "0x" + c.bytecode }; };
  if (out.errors && out.errors.some((e) => / Error/.test(e))) throw new Error(out.errors.join("\n"));
  return { V: get(":XDCValidator"), T: get(":Tok") };
}

fs.writeFileSync(path.join(__dirname, ".contracts.json"), JSON.stringify(compile()));
console.log("compiled");
