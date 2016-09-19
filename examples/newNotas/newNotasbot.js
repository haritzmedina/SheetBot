var SheetBot = require('../../src/SheetBot');

var notasSheetBot = new SheetBot('configuration.properties', 'notasBotDSL.json', '../client_secret.json');

notasSheetBot.startBot();