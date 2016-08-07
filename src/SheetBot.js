'use strict';

var GSheetManager = require('./GSheetManager');

class SheetBot{
    constructor(tokenFile, schemaFile, gSheetAuthFile){
        // Attributes
        this.model = this.model || {};
        this.model.tabularData = this.model.tabularData || {};

        // Initialization functions
        this.loadDependencies(tokenFile);
        this.loadSchema(gSheetAuthFile, schemaFile);
    }

    loadDependencies(tokenFile){
        // Properties file reader dependency
        this._PropertiesReader = require('properties-reader');
        // Read configuration file
        this.loadConfiguration(tokenFile);

        this._Botkit = require('botkit');
        this._fs = require('fs');
        this._readline = require('readline');
        this._wit = require('botkit-middleware-witai')({
            token: this._configuration.get('onekin.witai.token')
        });

        // Load bot dependencies
        this.model.botController = this._Botkit.slackbot();
        this.model.botController.middleware.receive.use(this._wit.receive);
        this.model.bot = this.model.botController.spawn({
            token: this._configuration.get('onekin.slack.token')
        });

        // Load tabular data dependencies
        this.model.tabularData.alasql = require('alasql');
    }

    loadSchema(gSheetAuthFile, schemaFile){
        // Read file
        this.model.schema = JSON.parse(this._fs.readFileSync(schemaFile, 'utf8'));

        // Load sheet data
        this.initializeTabularData(gSheetAuthFile, this.model.schema.tabularData);

        // Load intents behaviour
        this.loadGreetingsHandler(this.model.schema.greetings);
        this.loadIntents(this.model.schema.intents);
    }

    loadConfiguration(tokenFile){
        // Retrieve configuration for the project
        this._configuration = this._PropertiesReader(tokenFile);
    }

    initializeTabularData(gsheetAuthFile, tabularData) {
        this.model.tabularData.raw = this.model.tabularData.raw || {};
        var me = this;
        for(let tableSchema of tabularData){
            GSheetManager.loadRawData(
                gsheetAuthFile,
                tableSchema.gSheetToken,
                tableSchema.gSheetName,
                tableSchema.gSheetRange,
                (rawTable) => {
                    var tabularMetadata = {
                        'gSheetToken': tableSchema.gSheetToken,
                        'gSheetName': tableSchema.gSheetName,
                        'gSheetRange': tableSchema.gSheetRange,
                    };
                    me.updateRawData(tabularMetadata, rawTable);
                }
            );
        }
    }

    updateRawData(tabularMetadata, rawTable){
        var tabularDataId = tabularMetadata.gSheetToken+tabularMetadata.gSheetName+tabularMetadata.gSheetRange;
        // Check if data has changed since last time retrieved
        if(!GSheetManager.compareRawData(rawTable, this.model.tabularData.raw[tabularDataId])){
            // If changed, update raw data and reprocess alaSQL table
            this.model.tabularData.raw[tabularDataId] = rawTable;
            var formatedTable = this.formatRawTable(rawTable);
            this.updateAlaSQLTable(tabularMetadata.gSheetName, formatedTable);
        }
    }

    formatRawTable(rawTable){
        if(rawTable.length>1){
            var tabWrapper = [];
            for(let i=1;i<rawTable.length;i++){
                var row = {};
                for(let j=0;j<rawTable[0].length;j++){
                    row[rawTable[0][j]] = rawTable[i][j];
                }
                tabWrapper.push(row);
            }
            return tabWrapper;
        }
        else{
            return null;
        }
    }

    updateAlaSQLTable(tableName, formatedTable){
        // Delete and create table in alasql
        this.model.tabularData.alasql('DROP TABLE IF EXISTS '+tableName);
        this.model.tabularData.alasql('CREATE TABLE '+tableName);
        // Insert data in table
        this.model.tabularData.alasql('SELECT * INTO '+tableName+' FROM ?', [formatedTable]);
    }

    loadIntents(intents){
        for(let i=0;i<intents.length;i++){
            this.loadIntent(intents[i]);
        }
    }

    loadIntent(intent){
        var me = this;
        this.model.botController.hears([intent.ID], 'direct_message,direct_mention,mention', this._wit.hears, function(bot,message){
            // Retrieve from wit.ai the recognized entities which matches with required ones
            var entities = me.fillEntities(intent.entities, message.entities);
            // Retrieve non found entities on user message
            var nonFoundEntities = me.retrieveNonFoundEntities(entities);
            // TODO Create handler for last element

            // TODO Create handler for the rest of the elements

            // TODO Start the bot
        });
    }
    retrieveLastEntityHandler(entity){
        return () => {
            // TODO Ask Question

            // TODO Retrieve response

            // TODO Check if element exists in table (if not, send suggestions and re-ask)

            // TODO Create query

            // TODO Response with output
        };
    }

    retrieveEntityHandler(entity){
        return () => {
            // TODO Ask question

            // TODO Retrieve response

            // TODO Check if element exists in table (if not, send suggestions and re-ask)

            // TODO Call next handler
        };
    }




    fillEntities(definedEntities, foundEntities) {
        var remainEntities = JSON.parse(JSON.stringify(definedEntities));;
        for(let i=0; i<remainEntities.length;i++){
            if(foundEntities[definedEntities[i].column.toLowerCase()]){
                remainEntities[i].value = foundEntities[definedEntities[i].column.toLowerCase()][0].value;
                console.log("Found "+remainEntities[i].column+" value "+remainEntities[i].value);
            }
        }
        return remainEntities;
    }

    retrieveNonFoundEntities(entities) {
        var nonFoundEntities = [];
        for(let i=0;i<entities.length;i++){
            if(!entities[i].value){
                nonFoundEntities.push(entities[i]);
            }
        }
        return nonFoundEntities;
    }

    startBot(){
        this.model.bot.startRTM(function(err,bot,payload) {
            if (err) {
                throw new Error('Could not connect to Slack');
            }
        });
    }

    loadGreetingsHandler(responseMessage) {
        this.model.botController.hears(["greetings"], 'direct_message,direct_mention,mention', this._wit.hears, function(bot, message){
            bot.reply(message, responseMessage);
        });
    }
}

module.exports = SheetBot;