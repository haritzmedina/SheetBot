var SheetBot = require('../../src/SheetBot');

var conferenceBot = new SheetBot('configuration.properties', 'conferenceBot.json', '../client_secret.json');

conferenceBot.startBot();