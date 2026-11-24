// Tombola site settings. This is the only file to edit before deploying.
// Leave `draw` empty to show the "launching soon" state.
window.TOMBOLA_CONFIG = {
  // Public JSON-RPC for Robinhood Chain. Swap in a production RPC if the public one rate-limits.
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  chainId: 4663,
  // TombolaDraw: holds the pots and the draw ledger. Deployed at 0x6aF5B761F3C925f560D454813B1Dc36e0D12079F;
  // left empty until the token launches on Pons so the site shows "launching soon".
  draw: "0x6aF5B761F3C925f560D454813B1Dc36e0D12079F",
  // TombolaSplitter: Pons' creatorFeeRecipient; harvest() splits the escrow's ETH into the pots.
  splitter: "0x7b1fd52ca047b56E3456E24345477031Eadb8980",
  // The token (Pons' plain ERC-20), its Pons bonding curve, and the DrandBeacon the draw contract uses.
  token: "0x1C5b38d5Fd580Dcc7E19923862a1C9EeE383255b",
  curve: "0xCB219dB679bA9E674fc03ea2048495dcb14786c0",
  // Uniswap v4 PoolManager: where the token trades after graduation (excluded, and the buy source then).
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  beacon: "0xaf4fe3E1C2B4a6176392291704Fe4b87Df3b9A0E",
  // Pons' fee escrow (the splitter's `escrow()`): what it holds for the splitter is counted into the pots as
  // "waiting to be harvested". Empty: read from the splitter.
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  // The token's deploy block and its first block's timestamp (the cadence anchor the keeper uses). Set BEFORE launch;
  // every log scan starts at startBlock and the build warns while it is 0.
  startBlock: 94525469,
  launchTime: 1792610880,
  // Infra addresses that never hold tickets, besides the curve, PoolManager, splitter and draw above: Pons' locker,
  // zero and dead. The eligibility checker and Verify drop them, as the keeper does.
  exclude: [
    "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", // Pons locker
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
    // the team's wallets: they can hold and trade but never win (published with every snapshot)
    "0x32bf102d9d0d160a6e6cc21e225a9e8914ab90dd",
    "0xc48cC3f07b0285C84de83f24e531C1FEB97aCB12",
    "0x758e786d94F8B3999abCbC502aDc0C3C47D3d011",
    "0xbdD2e507de380b000409Fdba732df5e30888E7A0", // team fee wallet
    "0x4c6B36b84F14E3111c732136bb38803E82bBCC46", // deployer / guardian
    "0x9632ddbF691bFe009CA5A91B485CFb83497846De", // keeper
  ],
  // Where to buy.
  buyUrl: "https://ponsfamily.com/launchpad/0x1c5b38d5fd580dcc7e19923862a1c9eee383255b",
  // Where the bot publishes snapshot.json and serves POST /swarm-check (no trailing slash). Optional.
  botBase: "https://tombola-xbot.tombolarhlol.workers.dev",
  ticker: "TOMBOLA",
  // "crude" is the fairground host as written; "clean" swaps every line for a short polite set (src/lines.js).
  voice: "crude",
  explorer: "https://robinhoodchain.blockscout.com",
  // ETH/USD price for the plate's dollar figure (Fish, 21 Oct). Each visitor's browser asks CoinGecko, so their IP
  // goes there; set "" to go back to ETH only and no third-party call.
  priceUrl: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
  // IMD's API. Swarm attestation links are shown only if they are https on this origin.
  imdApi: "https://api.imd.fun",
  // Extra origins Verify may connect to with "verify with your own RPC" (the CSP is built from this file).
  extraConnect: [],
  // Local ports "verify with your own RPC" may use over http on localhost / 127.0.0.1 ([] for none).
  localRpcPorts: [8545],
};
