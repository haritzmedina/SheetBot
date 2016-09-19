var SheetBot = require('../../src/SheetBot');

var conferenceBot = new SheetBot('configuration.properties', 'newConferenceBot.json', '../client_secret.json');

conferenceBot.startBot();