var SheetBot = require('../../src/SheetBot');

var notasSheetBot = new SheetBot('configuration.properties', 'notasBot.json', '../client_secret.json');

notasSheetBot.startBot();