var SheetBot = require('../../src/SheetBot');

var notasSheetBot = new SheetBot('configuration.properties', 'conferenceBot.json', '../client_secret.json');

notasSheetBot.startBot();