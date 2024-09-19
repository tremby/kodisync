const JsonRpc = require("node-jsonrpc-client");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// Threshold for treating any two hosts' playback positions as in sync, in ms
const THRESHOLD = 1000;

function nearEnough(value, target) {
	return Math.abs(value - target) < THRESHOLD;
}

function getClient(host) {
	// Prefix with HTTP if it doesn't already start with http: or https:
	if (!/^https?:/.test(host)) host = `http:${host}`;

	// Parse as URL
	const url = new URL(host);

	// Add Kodi default port if it isn't set
	if (url.port === '') url.port = 8080;

	// Add Kodi JSONRPC endpoint if path isn't set
	if (url.pathname === '/') url.pathname = "/jsonrpc";

	return new JsonRpc(url.toString());
}

function timeToMs(time) {
	return time.hours * 60 * 60 * 1000 + time.minutes * 60 * 1000 + time.seconds * 1000 + time.milliseconds;
}

function pad(number, length) {
	let digits = number.toString().split("");
	if (digits.length < length) {
		digits = [...new Array(length - digits.length).fill(0), ...digits];
	}
	return digits.join("");
}

function msToString(stamp) {
	const ms = stamp % 1000;
	const s = Math.floor(stamp / 1000) % 60;
	const m = Math.floor(stamp / 1000 / 60) % 60;
	const h = Math.floor(stamp / 1000 / 60 / 60);
	return (h > 0 ? `${h}h` : '') + `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

async function wait(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function playingSameThing(hosts) {
	if (hosts.length < 2) return true;
	if (hosts.some((host) => host.playerid == null)) return false;
	return hosts.every((host, index) => {
		if (index === 0) return true;

		// Check if showtitle, season, and episode information is available (non-empty and not -1)
		const showInfoAvailable = host.currentItem.showtitle && hosts[0].currentItem.showtitle
			&& host.currentItem.season !== -1 && hosts[0].currentItem.season !== -1
			&& host.currentItem.episode !== -1 && hosts[0].currentItem.episode !== -1;

		// Check if showtitle, season, and episode match
		const showMatches = host.currentItem.showtitle === hosts[0].currentItem.showtitle
			&& host.currentItem.season === hosts[0].currentItem.season
			&& host.currentItem.episode === hosts[0].currentItem.episode;

		// Check if title or label matches
		const titleOrLabelMatches = host.currentItem.title === hosts[0].currentItem.title
			|| host.currentItem.label === hosts[0].currentItem.label;

		// Use showMatches if showInfoAvailable, otherwise use titleOrLabelMatches
		return showInfoAvailable ? showMatches : titleOrLabelMatches;
	});
}

function earliestPosition(hosts) {
	return hosts.reduce((acc, host) => Math.min(acc, host.position), Infinity);
}

class Host {
	constructor(hoststring) {
		this.hoststring = hoststring;
		this.client = getClient(hoststring);
	}

	async getResult(command, options) {
		this.querytime = Date.now();
		return (await this.client.call(command, options)).result;
	}

	async getPlayerResult(command, options) {
		return this.getResult(command, { playerid: this.playerid, ...options });
	}

	async updatePlayerId() {
		const player = (await this.getResult("Player.GetActivePlayers"))
			.find((player) => player.type === "video");
		this.playerid = player ? player.playerid : null;
	}

	async updateCurrentItem() {
		this.currentItem = (await this.getPlayerResult("Player.GetItem", {
			properties: [
				"tvshowid",
				"showtitle",
				"season",
				"episode",
				"title",
			],
		})).item;
	}

	async updatePlaybackStatus() {
		const result = await this.getPlayerResult("Player.GetProperties", {
			properties: [
				"speed",
				"time",
				"totaltime",
			],
		});
		this.speed = result.speed;
		this.position = timeToMs(result.time);
		this.duration = timeToMs(result.totaltime);
	}

	async updateStatus() {
		await Promise.all([
			this.updateCurrentItem(),
			this.updatePlaybackStatus(),
		]);
	}

	async pause() {
		const result = await this.getPlayerResult("Player.PlayPause", { "play": false });
		this.speed = 0;
		this.syncState = {
			state: "pause",
			position: this.position,
		};
	}

	async play() {
		const result = await this.getPlayerResult("Player.PlayPause", { "play": true });
		this.speed = result.speed;
		this.syncState = {
			state: "play",
			position: this.position,
			at: Date.now(),
		};
	}

	async seek(target) {
		await this.getPlayerResult("Player.Seek", { value: { percentage: 100 * target / this.duration }});
		// Seeking isn't accurate (isn't accurate by seconds either;
		// it's not just percentage mode), and doesn't immediately
		// report the correct new position
		await wait(2e3);
		await this.updatePlaybackStatus();
		this.syncState = {
			state: this.speed === 1 ? "play" : "pause",
			position: this.position,
			at: this.speed === 1 ? Date.now() : undefined,
		};
	}

	nowPlayingString() {
		if (!this.playerid) return "not playing a video";
		if (this.currentItem.showtitle) {
			return `${this.currentItem.showtitle} ${pad(this.currentItem.season, 2)}x${pad(this.currentItem.episode, 2)}, "${this.currentItem.title}"`;
		}
		return this.currentItem.title || this.currentItem.label;
	}
}

async function run() {
	const hosts = argv.host.map((hoststring) => new Host(hoststring));

	while (true) {
		// Get player IDs
		await Promise.all(hosts.map(async (host) => {
			await host.updatePlayerId();
			if (host.playerid) {
				await host.updateStatus();
			} else {
				// Reset sync state
				// FIXME: this should also be done when the
				// video being played changes
				host.syncState = null;
			}
		}));

		// If not everybody is playing the same episode,
		// wait until they are
		if (!playingSameThing(hosts)) {
			console.log("Not all hosts are playing the same thing.\n" + hosts.map((host) => `- ${host.hoststring}: ${host.nowPlayingString()}`).join("\n"));
			await wait(1e3);
			continue;
		}

		// Update sync states
		for (const host of hosts) {
			if (host.syncState == null) continue;
			if (host.speed === 0) {
				if (host.syncState.state !== "pause") {
					console.log(`${host.hoststring} is newly paused`);
					host.oldSyncState = host.syncState;
					host.syncState = null;
					continue;
				}
				if (!nearEnough(host.position, host.syncState.position)) {
					console.log(`${host.hoststring} has seeked while paused from ${msToString(host.syncState.position)} to ${msToString(host.position)}`);
					host.oldSyncState = host.syncState;
					host.syncState = null;
					continue;
				}
				continue;
			}
			if (host.speed === 1) {
				if (host.syncState.state !== "play") {
					console.log(`${host.hoststring} is newly playing`);
					host.oldSyncState = host.syncState;
					host.syncState = null;
					continue;
				}
				// Check it's roughly where it should be
				const target = host.syncState.position + host.querytime - host.syncState.at;
				if (!nearEnough(host.position, target)) {
					console.log(`${host.hoststring} has seeked while playing from ~${msToString(target)} to ${msToString(host.position)}`);
					host.oldSyncState = host.syncState;
					host.syncState = null;
					continue;
				}
				continue;
			}
			// Else we might be seeking; ignore
		}

		// How many are not synced
		const unsyncedCount = hosts.reduce((acc, host) => acc + (host.syncState == null ? 1 : 0), 0);

		// If two or more are unsynced,
		// pause everybody and seek to the earliest timestamp
		if (unsyncedCount > 1) {
			console.log("Syncing all together");
			await Promise.all(hosts.map(async (host) => {
				if (host.speed !== 0) {
					await host.pause();
				}
				await host.updatePlaybackStatus();
			}));
			const target = earliestPosition(hosts);
			await Promise.all(hosts.map(async (host) => {
				await host.seek(target);
			}));

			console.log("Ready");
			continue;
		}

		// If exactly one is unsynced,
		// attempt to match others to its state
		if (unsyncedCount === 1) {
			const primary = hosts.find((host) => host.syncState == null);
			const secondaries = hosts.filter((host) => host !== primary);

			if (primary.speed === 1) {
				// Just started playing, or seeked;
				// pause to let others sync
				console.log(`Pausing all to let everyone sync`);
				await Promise.all(hosts.map(async (host) => host.pause()));
				await primary.updatePlaybackStatus();
				console.log(`primary is at ${msToString(primary.position)}`);

				// Sync up
				console.log(`Seeking others to ${msToString(primary.position)}`);
				await Promise.all(secondaries.map(async (host) => host.seek(primary.position)));

				// Find the earliest timestamp
				const zeroPoint = earliestPosition(hosts);

				// Stagger playback in an attempt to sync them
				console.log("Staggering play commands to sync");
				await Promise.all(hosts.map(async (host) => {
					const waitTime = host.position - zeroPoint;
					await wait(waitTime);
					console.log(`Playing ${host.hoststring} having waited ${waitTime}ms`);
					await host.play();
				}));

				console.log("Ready");
				continue;
			}

			if (primary.speed === 0) {
				primary.syncState = {
					state: "pause",
					position: primary.position,
				};
				await Promise.all(secondaries.map(async (host) => {
					console.log(`Pausing and seeking ${host.hoststring} to ${msToString(primary.position)}`);
					await host.pause();
					await host.seek(primary.position);
				}));

				console.log("Ready");
				continue;
			}

			throw new Error(`Unexpected speed ${primary.speed}; we shouldn't be syncing anybody to anything but play or pause`);
		}

		// Wait briefly before checking again
		await wait(0.5e3);
	}
}

async function runAndReport(fn) {
	try {
		return fn();
	} catch (error) {
		console.error(error);
	}
}

// Handle command line arguments
const argv = yargs(hideBin(process.argv))
	.command("$0 <host...>", "Sync playback of Kodi instances", (yargs) => {
		yargs
			.positional("host", {
				describe: "Kodi host (eg localhost or my.friends.server:1234)",
			})
	})
	.argv;

runAndReport(run);
