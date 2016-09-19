var SheetBot = require('../../src/SheetBot');

var tripadvisorBot = new SheetBot('configuration.properties', 'newTripadvisor.json', '../client_secret.json');

tripadvisorBot.startBot();