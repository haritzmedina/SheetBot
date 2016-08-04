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

        this.model.tabularData.alasql = require('alasql');
    }

    loadSchema(gSheetAuthFile, schemaFile){
        // Read file
        this.model.schema = JSON.parse(this._fs.readFileSync(schemaFile, 'utf8'));

        // Load sheet data
        this.initializeTabularData(gSheetAuthFile, this.model.schema.tabularData);

        // TODO Load intents behaviour
        console.log('a');
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
}

module.exports = SheetBot;