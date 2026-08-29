#!/usr/bin/env node

const LinkedinClient = require('./LinkedinClient');

async function main() {
	if (process.argv.length < 3 || !process.argv[2]) {
		console.error('Usage: node --env-file=.env src/cli.js https://www.linkedin.com/in/example/');
		process.exitCode = 1;
		return;
	}
	try {
		const result = await new LinkedinClient().fetch(process.argv[2]);
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(error.code || error.message);
		process.exitCode = 1;
	}
}

void main();
