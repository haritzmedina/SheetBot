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
            // Check if retrieved entities exists (or need to ask for them)
            entities = me.checkEntitiesExistenceInDatabase(entities, intent.sourceTable);
            // Retrieve non found entities on user message
            var nonFoundEntities = me.retrieveNonFoundEntities(entities);
            var initialResponseHandler = null; // TODO Define initial response handler
            if(nonFoundEntities.length>0){
                // TODO Create handler for last element
                let currentElementHandler = me.retrieveLastEntityHandler(nonFoundEntities[0], entities, intent);
                // TODO Create handler for the rest of the elements
                for(let i=1;i<nonFoundEntities.length;i++){
                    currentElementHandler = me.retrieveEntityHandler(
                        nonFoundEntities[i], entities, intent, currentElementHandler);
                }
                initialResponseHandler = currentElementHandler;
            }
            else{
                //TODO Define conversation handler with the response
                initialResponseHandler = me.retrieveNoRequiredEntityHandler(entities, intent);

            }
            // Start the conversation
            bot.startConversation(message, initialResponseHandler);
        });
    }

    retrieveLastEntityHandler(currentEntity, entities, intent){
        var me = this;
        return (response, convo) => {
            // TODO Ask Question
            convo.ask(currentEntity.columnQuestion, (response, convo) => {
                // TODO Retrieve response
                let userResponse = response.text;
                // TODO Check if element exists in table (if not, send suggestions and re-ask)
                if(me.checkValueExistsInDatabase(
                        currentEntity.column, userResponse, currentEntity.function, intent.sourceTable)){
                    // Create query
                    me.fillEntity(currentEntity.column, userResponse, entities);
                    let sqlQuery = me.createSQLQuery(entities, intent);
                    console.log('Query: '+sqlQuery);
                    // TODO Execute query
                    var results = this.executeSQLQuery(sqlQuery);
                    // TODO Prepare response
                    var responses = this.parseQueryResults(results, intent.response);
                    // TODO Response with output
                    if(responses.length>0){
                        for(let i=0;i<responses.length;i++){
                            convo.say(responses[i]);
                        }
                    }
                    else{
                        if(intent.response.customNoResultsFoundMessage){
                            convo.say(intent.response.customNoResultsFoundMessage);
                        }
                        else{
                            convo.say("Results not found");
                        }
                    }
                }
                else{
                    // TODO Repeat question
                    //convo.ask(currentEntity.suggestionCustomMessage, me.retrieveRepeatQuestionHandler());
                    console.log('Elements not exists');
                }
                // Finish answer processing
                convo.next();
            });
        };
    }

    retrieveRepeatQuestionHandler(currentEntity, entities, intent) {
        var me = this;
        return (response, convo) => {
            // TODO Retrieve response
            let userResponse = response.text;
            // TODO Check if element exists in table (if not, send suggestions and re-ask)
            if(me.checkValueExistsInDatabase(
                    currentEntity.column, userResponse, currentEntity.function, intent.sourceTable)){
                // TODO Create query

                // TODO Response with output
            }
            else{
                convo.ask(currentEntity.suggestionCustomMessage, me.retrieveRepeatQuestionHandler(currentEntity, entities, intent));
                console.log('Elements not exists');
            }
            // Finish answer processing
            convo.next();
        }
    }

    retrieveEntityHandler(currentEntity, entities, intent, nextEntityCallback){
        return () => {
            // TODO Ask question

            // TODO Retrieve response

            // TODO Check if element exists in table (if not, send suggestions and re-ask)

            // TODO Call next handler
        };
    }

    retrieveNoRequiredEntityHandler(entities, intent) {
        return (response, convo) => {
            // Create query
            var sqlQuery = this.createSQLQuery(entities, intent);
            // Execute query
            var results = this.executeSQLQuery(sqlQuery);
            // TODO Prepare response
            var responses = this.parseQueryResults(results, intent.response);
            // TODO Response with output
            if(responses.length>0){
                for(let i=0;i<responses.length;i++){
                    convo.say(responses[i]);
                }
            }
            else{
                if(intent.response.customNoResultsFoundMessage){
                    convo.say(intent.response.customNoResultsFoundMessage);
                }
                else{
                    convo.say("Results not found");
                }
            }
            // Finish answer processing
            convo.next();
        }
    }

    createSQLQuery(entities, intent){
        // Construct where condition based on entities
        let whereCondition = "";
        for(let i=0;i<entities.length;i++){
            whereCondition += " "+this.whereConditionParsing(entities[i].column, entities[i].function, entities[i].value);
        }
        let sqlQuery = this.parseQuery('SELECT %s FROM %s WHERE %s',
            intent.response.outputColumn,
            intent.sourceTable,
            whereCondition);
        return sqlQuery;
    }

    whereConditionParsing(column, operand, value){
        const parsingMethods = {
            "LIKE" : (value) => {
                return "\"%"+value+"%\"";
            },
            "=" : (value) => {
                return  "\""+value+"\"";
            },
            "!=": (value) => {
                return  "\""+value+"\"";
            },
            ">": (value) => {
                return  "\""+value+"\"";
            },
            ">=": (value) => {
                return  "\""+value+"\"";
            },
            "<": (value) => {
                return  "\""+value+"\"";
            },
            "<=": (value) => {
                return  "\""+value+"\"";
            },
            "!<": (value) => {
                return  "\""+value+"\"";
            },
            "!>": (value) => {
                return  "\""+value+"\"";
            }
        };
        if(parsingMethods[operand]){
            return column+" "+operand+" "+parsingMethods[operand](value);
        }
        else{
            return column+" = "+value;
        }
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

    fillEntity(column, value, entities){
        for(let i=0;i<entities.length;i++){
            if(entities[i].column.toLowerCase()===column.toLowerCase()){
                entities[i].value = value;
            }
        }
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

    checkEntitiesExistenceInDatabase(entities, sourceTable) {
        for(let i=0;i<entities.length;i++){
            if(!this.checkValueExistsInDatabase(entities[i].column, entities[i].value, entities[i].function, sourceTable)){
                entities.value = null; // Remove user input value cause not exists in database (need to ask for it)
            }
        }
        return entities;
    }

    checkValueExistsInDatabase(column, value, operand, sourceTable) {
        let whereCondition = this.whereConditionParsing(column, operand, value);
        let sqlQuery = this.parseQuery(
            'SELECT COUNT(*) AS number FROM %s WHERE %s',
            sourceTable,
            whereCondition);
        console.log(sqlQuery);
        let result = this.executeSQLQuery(sqlQuery);
        return result[0].number > 0;
    }

    parseQuery(str){
        var args = [].slice.call(arguments, 1),
            i = 0;

        return str.replace(/%s/g, function() {
            return args[i++];
        });
    }

    executeSQLQuery(sqlQuery) {
        return this.model.tabularData.alasql(sqlQuery);
    }

    parseQueryResults(results, definedResponse) {
        var responses = [];
        for(let i=0;i<definedResponse.numberOfResponses;i++){
            if(results[i]){
                let response = "";
                let outputColumns = Object.keys(results[i]);
                for(let j=0;j<outputColumns.length;j++){
                    if(definedResponse.showColumnName){
                        response += outputColumns[j]+": "+results[i][outputColumns[j]]+"\n";
                    }
                    else{
                        response += results[i][outputColumns[j]]+"\n";
                    }
                }
                responses.push(response);
            }
        }
        return responses;

    }
}

module.exports = SheetBot;