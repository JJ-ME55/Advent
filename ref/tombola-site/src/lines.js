// The host's mouth. A bank of lines in the fairground barker's voice: cruel, delighted, filthy, and so over the
// top it's silly. Every insult points at "you, the greedy basement degenerate" and nowhere else. No price talk,
// no "guaranteed". Placeholders: {pot} {wallets} {mins} (only under the countdown kind) {time} ("2h 14m" to the next drop, read live) {ticker} {who} {amount}. A line whose placeholder has no live value is skipped. Shared with the X bot and the video.
export const LINES = {
  curtain: [
    ["Step right up, you disgusting piss-smelling fucking degenerate.", "Every few hours one of you greedy little shitgoblins walks off with the pot. Could be you. Almost certainly won't be."],
    ["Welcome to Tombola, you greasy, basement-dwelling, Dorito-fingered fuckwit.", "Hold the token, get your tickets in the drum, and pray the balls like you more than your own mother does."],
    ["Oi. Yes, you. The one who smells like a bin fire fucked a wet dog.", "Get in here. The drum's turning, the pot's filling, and some lucky bastard is leaving rich. Not you, statistically. But someone."],
    ["Roll up, roll up, you sweaty little gambling shitweasels.", "ETH drops every few hours to one wallet. No skill, no sense, no shame required. You'll fit right fucking in."],
    ["Well, well, well. Another broke degenerate sniffing around for a handout.", "Good news, you magnificent piece of shit: this one's real. Hold the token, win the pot. Come in before you piss yourself."],
    ["Wipe your feet, you crusty cum-sock of a human being.", "Inside: a drum full of balls, a pot full of ETH, and a winner every few hours. Outside: your sad fucking life. Choose."],
  ],
  // pure heckles with no live numbers: shouted before and after launch, mixed in with idle / soon
  heckle: [
    "Oi, you. Yes, you, with the face like a dropped pie. Step right up before someone with a working brain takes your spot.",
    "Look at you. Sat there in your pants, scrolling with one hand, eating cereal out of the box with the other. A champion in waiting.",
    "You've got the financial instincts of a moth in a candle shop. Luckily this needs none. Hold the token. Win the pot.",
    "Don't miss out, you absolute walnut. The drum doesn't wait and neither does the bloke next to you.",
    "I can smell you through the screen. It's a mix of regret, Monster Energy and the last three coins you aped into. Step up anyway.",
    "Your portfolio looks like a crime scene. Come and do something about it, you gorgeous disaster.",
    "Step right up, you glorious bin-juice of a man. Or woman. Or whatever's left after four years of crypto.",
    "Everyone who ever got rich took one look at the odds and said fuck it. Be the fuck-it, not the odds.",
    "Your mum thinks you're a software engineer. We both know you're a degenerate with a MetaMask. Lean into it.",
    "Hold the token like it's the last chicken nugget at a kids' party. Clutch it. Guard it. Growl at people.",
    "You've refreshed this page nine times and bought nothing. That's not research, sweetheart, that's foreplay with yourself.",
    "The drum spins for the brave, the bold and the deeply, deeply stupid. Good news: you qualify on all three.",
    "Somewhere out there a winner is being picked. It won't be you if you keep standing there like a fucking lamp post.",
    "Stop reading the rules, you nervous little hamster. Nobody's ever read the rules. Hold the token.",
    "You call that a bag? I've seen bigger bags under a toddler's eyes. Top up, you tight-fisted gremlin.",
    "Every drop pays one wallet. One. Not the loudest. Not the smartest. Just the one that held. Even you could hold, surely.",
    "I've seen a jellyfish with more conviction. Buy the fucking ticket.",
    "Your ex is in the drum. Your ex is going to win. Your ex is going to post about it. Are you going to let that happen?",
    "Life is short, the pot is fat, and you've got the attention span of a goldfish on ketamine. Act now.",
    "If you're reading this, you've already lost three minutes of your life. Make them count, you daft bastard. Hold the token.",
    "Step right up, you gloriously unemployable shit-wizard. Fortune favours the bold and the barely literate.",
    "Hold for 30 minutes to be in the drum. You've held a grudge against your brother for nine years. You can do this.",
    "Patience, you twitchy little gremlin. Hold longer, get more tickets. Up to three times more. Like compound interest, but for cowards.",
    "Sell and your hold clock goes back to zero. Zero. Like your dating prospects. Don't fucking sell.",
    "Nobody picks the winner. Not me. Not the team. Not your sad little prayers to the candle gods. drand picks it on-chain.",
    "Don't believe me? Good. You shouldn't. Press Verify and watch your own browser redo the whole fucking draw.",
    "You smell like a server room that's been crying. Come in, hold the token, cheer up.",
    "The last winner was just like you, except they held and you dithered. Be like them. Dither less.",
    "I'm a loudspeaker on a stick and I've still got more conviction than your whole fucking watchlist.",
    "You've got the hands of a surgeon and the nerve of a wet lettuce. Paper hands never win raffles, pet.",
    "This is the only fairground where the goldfish you win is worth something. Step up, you tragic little ferret.",
    "Oi, Dorito-fingers. Wipe your hands before you touch the drum. Then hold the fucking token.",
    "Every few hours a wallet gets paid. Every few hours you tell yourself you'll buy tomorrow. Tomorrow's a lie, mate.",
    "You hesitate like a man choosing a urinal. Pick one. Hold it. Win.",
    "Don't miss out, you sentient pile of laundry. The pot grows while you dither.",
    "If stupidity were a ticket you'd have a billion. Sadly it isn't. Hold the token instead.",
    "You look like you'd lose a staring contest to a potato. Luckily the drum doesn't care. Get in it.",
    "Step right up, you shrivelled little bin-raccoon. The drum's warm, the pot's fat, and the odds are the best thing in your life.",
    "Hold the token. Hold your nerve. Hold your breath if you have to, you gormless wonder.",
    "Somebody's going to win and it's going to be some absolute nobody. Why not be the absolute nobody? You've got the experience.",
    "You've got less patience than a toddler at a funeral. Hold for 72 hours and get triple the tickets. Try it, you spasmodic weasel.",
    "The pot doesn't care about your feelings. It cares about who held. So hold, you big soft bastard.",
    "Get in the drum, you sweaty little mouth-breather. The balls are tumbling and one of them wants your name.",
    "I've met pub carpets with more drive than you. Buy. Hold. Win. Or go back to your carpet.",
    "This isn't a drill, this isn't a scam, this isn't your uncle's crypto group. It's a drum full of balls and a pot full of ETH.",
    "There are two kinds of degenerates: the ones in the drum and the ones crying about it on X. Pick, you daft sod.",
    "Your luck's been so bad lately you could fall in a barrel of tits and come out sucking your thumb. Change it. Hold the token.",
    "You are a magnificent, greasy, forty-tab-having fuck-up and I love you. Now get in the drum.",
    "You've spent more on failed presales than on your own teeth. For once, do the thing where you win.",
    "Step right up, you wobbling bag of bad decisions. Here's a good one for a change.",
    "Hold the fucking token. I'll say it slower for the back row: hold. The. Fucking. Token.",
    "You, specifically, are the reason this page has a tannoy. Someone had to shout at you. Get in the drum.",
    "I'd call you a sheep but sheep follow something. You just stand there. Move, you fleece-brained pillock.",
    "The drum has no memory and no mercy, which makes it the perfect place for someone with your history.",
    "Don't just stand there with your gob open like a letterbox. Hold the token. Win the pot.",
    "Don't miss out. Don't miss out. Don't miss out, you moist little toe-rag. That's three. I'm not saying it again.",
    "The pot grows with every trade. Every trade. Even the shit ones. Especially the shit ones. Yours would help.",
    "You've got the odds of a ticket and the charisma of a damp sock. One of those is fixable right now.",
    "If you held your girlfriend like you hold your tokens, she'd have left you sooner. Hold properly.",
    "Step right up and prove your mum wrong about you, you big beautiful disappointment.",
    "Winners hold. Losers refresh the chart every nine seconds like a pigeon pecking a button. Which one are you, pet?",
    "I've seen a snail cross a road with more urgency. Get in the drum, you shell-less wonder.",
    "Look, the drum doesn't care if you're a whale or a shrimp. It cares if you held. Even shrimps win here. Mostly shrimps, honestly.",
    "You've got main character energy and sidekick luck. Fix the luck. Hold the token.",
    "You absolute spoon. You beautiful, hopeless, lovely spoon. Get in the fucking drum.",
    "The weekly mega's coming, and someone's going to win it with their arse in a bath. Could be your arse. Could be your bath.",
    "Hold the token for a few hours and you'll be a better person. Not much better. But better.",
    "If you've got time to read this, you've got time to be in the drum, you lazy little sod.",
    "Your wallet's emptier than a vegan's barbecue. Fill it with tickets, not excuses.",
    "Tickets aren't given. They're held. Like a job. Something you've heard of, I presume.",
    "Nobody ever won a raffle from the car park. Get in here, you pathetic little bollard.",
    "Step right up, you glorious waste of bandwidth. The drum's got a ball with your name misspelled on it.",
    "There's a wallet out there right now with a 0.4% chance of winning, and it's got more balls than you. Literally.",
    "You dress like a bin bag and think like one too. Doesn't matter. The drum picks on tickets, not taste.",
    "The odds are long, the pot is real, and the clock is ticking, you dozy hunk of bread.",
    "Hold your tokens like they owe you money. Because, with a bit of luck, they will.",
    "You've got that look. The look of a man who put his rent into a frog coin. Welcome home, you prodigal shit.",
    "Winners are picked by randomness the contract checks itself. Losers are picked by hesitation. Stop hesitating, dickhead.",
    "I'm not saying you'll win. I'm saying you'll definitely never win from over there, you cowardly biscuit.",
    "Don't let the big wallets scare you. They've got more tickets, sure, but they've also got more divorces. Hold the token.",
    "You've got a lot of nerve showing your face here. Good. Nerve's the only thing we need. Hold the token.",
    "Blink twice if you're in the drum. No? Then stop blinking and start buying, you useless meat curtain.",
    "The pot is a pile of ETH with no owner. You are a pile of excuses with no ETH. You see the opportunity, surely.",
    "Get in here, you leathery, nocturnal, Discord-dwelling degenerate. There's a drum with your name on it.",
    "Fuck around and find out, except here finding out might pay you. Hold the token.",
    "You were born for this. Not for winning, obviously. For standing near winners and shouting. But maybe. Maybe.",
    "Your mum said you were special. She meant the other kind. Prove her wrong, you radiant halfwit. Hold the token.",
    "Buying a ticket isn't brave. Holding it when the chart wobbles, that's brave. Be brave, you quivering custard.",
    "I don't care who you are. I don't care what you've lost. The drum's open and it'll take anyone. Even you. Especially you.",
    "This is the part where you stop reading and start holding, you flaccid little procrastinator.",
    "You've got the posture of a question mark and the prospects of a full stop. Hold the token and stand up straight.",
    "Oi, bin-breath. The pot's not going to hold itself. Well, it is, actually. But you're not in it. Fix that.",
    "I've seen more spine in a packet of crisps. Hold the fucking token.",
    "You've got a face only a drum could love. Good news: the drum doesn't have eyes. Get in.",
    "Hold the token, win the pot, buy your mum a proper fridge. The one she's got hums like it's dying.",
    "Someone's about to win and they're probably wearing socks with holes in. Just like you. See? You're halfway there.",
    "Right, listen. One ball. One wallet. One pot. Every few hours. It's not rocket science, it's a fucking tombola. Get in.",
    "EOF",
  ],
  idle: [
    "Oi, dickhead. The pot's sitting at {pot} ETH and you're just standing there scratching your arse.",
    "{wallets} wallets in the drum. {wallets} greedy little bastards with a better chance than you. Fix that.",
    "Next drop in {time}, you absolute waste of a chair. Are you in the drum or are you just fucking browsing?",
    "Step right up and hold the fucking token. Or don't, and watch some other prick get paid. Your call, sunshine.",
    "Every few hours one of you gets rich and the rest of you cry into your energy drinks. Don't miss your turn, you beautiful shit-stain.",
    "I've seen braver decisions from a wet paper bag. Buy the ticket. Hold the ticket. Stop being a coward.",
    "Still here? Still not in the drum? Christ alive, you'd lose a raffle with one ticket in it.",
    "Your mum rang. She said get in the drum and stop embarrassing the family, you limp fucking noodle.",
    "Hold {ticker} for 30 minutes and you're in. Thirty minutes. You've spent longer than that choosing a wank video.",
    "The balls are tumbling, the pot's growing, and you're dithering like a goldfish at a fucking buffet. Step up.",
    "Hold longer, get more tickets. Up to three times more. Patience, you twitchy little gremlin. Try it once in your life.",
    "Nobody picks the winner. Not me, not the team, not your sad little prayers. drand picks it on-chain. Now get in the fucking drum.",
    "Sell and your hold clock resets to zero, you impatient shitgibbon. Hold it like you hold grudges.",
    "Look at that pot. Look at it. Now look at your bank balance. Now look at the pot again. Get in the drum, you daft bastard.",
    "This isn't a drill, this isn't a scam, this is a drum full of balls and one of them's got your fucking name on it. Maybe.",
    "You've got the reaction speed of a dead badger. The drop's coming. Be in it.",
    "Don't miss out, you miserable piss-flannel. Hold the token, get the tickets, win the ETH. Three steps. Even you can count that high.",
    "{wallets} wallets in the draw and every single one of them has more courage than you. Embarrassing, really.",
    "A wallet, some tokens and thirty minutes of patience. That's it. That's the whole fucking entry fee, you tight-fisted gremlin.",
    "The drum doesn't care who you are. Rich, poor, ugly, uglier. One ticket per token. Hold more, win more often. Simple, dickhead.",
  ],
  soon: [
    "Not open yet, you eager little cum-stain. The drum's being built. Come back when there's something to lose.",
    "Launching soon. Which means right now you're staring at an empty cage like a fucking idiot at a zoo.",
    "The balls aren't in yet. Neither is your money. One of those is about to change, you greedy bastard.",
    "Patience, you twitchy shitweasel. The first drop lands one hour after trading opens. Set an alarm. Or don't, and miss it like you miss everything.",
    "Pre-launch. Tell your degenerate mates. Tell your mum. Tell the bloke who sold you that NFT of a monkey.",
  ],
  countdown: [
    "{mins} minutes to the drop, you sweaty little goblins. Hold your tokens and hold your fucking nerve.",
    "Under ten minutes. Snapshot's coming. Anyone selling now deserves everything they don't get.",
    "{mins} minutes. {pot} ETH. {wallets} wallets. One winner. Odds are shit, but they're yours, you beautiful degenerate.",
    "Nearly time. If you're not in the drum by now you're not in the drop, so stop fucking reading and go buy.",
  ],
  buy: [
    "A new ball rolls in! Some brave bastard just bought. Unlike you, probably.",
    "Fresh meat in the drum. Welcome aboard, you gorgeous little degenerate.",
    "Another wallet steps up. The pot grows, the drum fills, and you're still sat there with your dick in your hand.",
    "Ding ding! New ball! Someone actually read the rules. Miracles do fucking happen.",
    "Buy spotted. Bold. Stupid, maybe. But bold. Roll on in, you magnificent idiot.",
  ],
  sell: [
    "And one drops out the bottom. Paper hands. Enjoy watching the next drop from the car park, you quitter.",
    "A ball leaves the drum. Somebody sold. Somebody's mum is disappointed. Again.",
    "Sold! Hold clock reset, ticket gone, dignity gone. Thanks for playing, you spineless fucking jellyfish.",
    "There goes one. Out the hatch, into the bin, straight back to being broke. Lovely stuff.",
    "Sell detected. The drum is lighter, the odds are better for everyone who isn't a coward. Cheers, mate.",
  ],
  winner: [
    "WINNER! {who} takes {amount}! Everyone else, wipe your tears with your worthless fucking bags.",
    "And the drum coughs up a champion: {who} walks off with {amount}. The rest of you can keep dreaming, you sad bastards.",
    "{who} just got paid {amount} for the heroic act of not selling. Learn something, you fidgety little shits.",
    "Ding ding ding! {amount} to {who}. Was it you? No? Course it fucking wasn't. Next drop's in a few hours. Hold on.",
    "{amount} ETH out the door to {who}. Somebody's buying a round. Somebody else is crying in the toilets.",
  ],
  rollover: [
    "Nobody eligible. Nobody! The pot rolls into the next drop, you useless shower of shit. Hold your fucking tokens.",
    "No winner this time because none of you held long enough. Pathetic. The pot gets fatter. Try again.",
  ],
  swarm: [
    "Ask the swarm. A hive of machines checks every draw so you don't have to trust me, you paranoid little fuck. And you shouldn't.",
    "Don't believe a word I say. Press the button, let the swarm check the maths. It's got more brains than you anyway.",
  ],
};

// A short, clean fallback for when the config says voice: "clean".
export const CLEAN = {
  curtain: [["Step right up.", "Hold the token, get tickets in the drum, and win ETH every few hours."]],
  idle: ["The pot's at {pot} ETH with {wallets} wallets in the drum. Next drop in {time}.", "Hold {ticker} for 30 minutes and you're in the draw.", "Hold longer, get more tickets: up to 3x at 72 hours."],
  soon: ["Launching soon. The first drop lands one hour after trading opens."],
  countdown: ["{mins} minutes to the drop. Snapshot coming."],
  buy: ["A new ball rolls into the drum."],
  sell: ["A ball drops out of the drum."],
  winner: ["{who} wins {amount}."],
  rollover: ["Nobody was eligible. The pot rolls into the next drop."],
  swarm: ["Ask the swarm to check the recent draws."],
};

/** A short stable id for a line, used to name its voice clip (FNV-1a, hex). Same in the browser and in node. */
export function hashLine(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Every line that can be spoken as recorded: no live placeholders. Curtain greetings are head and sub joined. */
export function spokenLines(bank) {
  const out = new Set();
  for (const [kind, list] of Object.entries(bank)) {
    for (const l of list) {
      const text = Array.isArray(l) ? l.join(" ") : l;
      if (!/\{\w+\}/.test(text)) out.add(text);
    }
    void kind;
  }
  return [...out];
}

/** Picks a line of a kind from a shuffled bag, so nothing repeats until every line of that kind has been heard. */
let lastRaw = "";
/** The unfilled text of the line the picker last returned (names its voice clip). */
export const lastPicked = () => lastRaw;

export function makePicker(bank) {
  const bags = {};
  // before and after launch the pure heckles join the rotation
  const pool = (kind) => (bank[kind] || []).concat(kind === "idle" || kind === "soon" ? bank.heckle || [] : []);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  return (kind, vars = {}) => {
    const list = pool(kind);
    if (!list.length) return "";
    if (!bags[kind]?.length) bags[kind] = shuffle(list.map((_, i) => i));
    const usable = (t) => (Array.isArray(t) ? t.join(" ") : t).match(/\{(\w+)\}/g)?.every((p) => vars[p.slice(1, -1)] !== undefined && vars[p.slice(1, -1)] !== "") ?? true;
    const bag = bags[kind];
    let at = -1;
    for (let i = bag.length - 1; i >= 0; i--) if (usable(list[bag[i]])) { at = i; break; }
    if (at < 0) return "";
    const line = list[bag.splice(at, 1)[0]];
    const fill = (t) => t.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
    const out = Array.isArray(line) ? line.map(fill) : fill(line);
    // the raw line (before placeholders) names its voice clip, if one was recorded
    lastRaw = Array.isArray(line) ? line.join(" ") : line;
    return out;
  };
}
