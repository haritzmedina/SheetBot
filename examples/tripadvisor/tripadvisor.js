var SheetBot = require('../../src/SheetBot');

var tripadvisorBot = new SheetBot('configuration.properties', 'tripadvisor.json', '../client_secret.json');

tripadvisorBot.startBot();