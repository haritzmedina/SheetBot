'use strict';

var GSheetManager = require('./GSheetManager');

class SheetBot{
    constructor(tokenFile, schemaFile, gSheetAuthFile){
        // Attributes
        this.model = this.model || {};
        this.model.tabularData = this.model.tabularData || {};
        this.model.tabularData.gSheetAuthFile = gSheetAuthFile;

        // Initialization functions
        this.loadDependencies(tokenFile);
        this.loadSchema(gSheetAuthFile, schemaFile);

        // Defined static values
        this.params = {};
        this.params.maxSuggestions = 7;
        this.params.defaultNumberOfResponses = 1;
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
        this.initializeTabularData(this.model.tabularData.gSheetAuthFile, this.model.schema.tabularData);

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
        for(let tableSchema of tabularData){
            this.updateTable(tableSchema);
        }
    }

    updateTable(tableSchema, callback){
        var me = this;
        GSheetManager.loadRawData(
            this.model.tabularData.gSheetAuthFile,
            tableSchema.gSheetToken,
            tableSchema.gSheetName,
            tableSchema.gSheetRange,
            (rawTable) => {
                var tabularMetadata = {
                    'gSheetToken': tableSchema.gSheetToken,
                    'gSheetName': tableSchema.gSheetName,
                    'gSheetRange': tableSchema.gSheetRange,
                    'tableName': tableSchema.tableName
                };
                me.updateRawData(tabularMetadata, rawTable);
                if(callback && typeof callback==='function'){
                    callback();
                }
            }
        );
    }

    updateRawData(tabularMetadata, rawTable){
        var tabularDataId = tabularMetadata.gSheetToken+tabularMetadata.gSheetName+tabularMetadata.gSheetRange;
        // Check if data has changed since last time retrieved
        if(!GSheetManager.compareRawData(rawTable, this.model.tabularData.raw[tabularDataId])){
            // If changed, update raw data and reprocess alaSQL table
            this.model.tabularData.raw[tabularDataId] = rawTable;
            var formatedTable = this.formatRawTable(rawTable);
            this.updateAlaSQLTable(tabularMetadata.tableName, formatedTable);
            console.log('Updated table: '+tabularMetadata.tableName);
        }
    }

    formatRawTable(rawTable){
        if(rawTable.length>1){
            var tabWrapper = [];
            for(let i=1;i<rawTable.length;i++){
                var row = {};
                for(let j=0;j<rawTable[0].length;j++){
                    row[rawTable[0][j]] = this.parseRawCell(rawTable[i][j]);
                }
                tabWrapper.push(row);
            }
            return tabWrapper;
        }
        else{
            return null;
        }
    }

    parseRawCell(rawCell){
        // Check data is not empty or error (null, undefined, NaN,...)
        if(!rawCell){
            // TODO Throw exception
            return '';
        }
        else{
            // If data is a number it converts automatically to a number
            let cellNumberIntent = Number(rawCell);
            if(isNaN(cellNumberIntent)){
                return rawCell
            }
            // Else maintains as a string
            else{
                return cellNumberIntent;
            }
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
            me.checkEntitiesExistenceInDatabase(entities, intent.sourceTable, (entities) => {
                // Retrieve non found entities on user message
                var nonFoundEntities = me.retrieveNonFoundEntities(entities);
                var initialResponseHandler = null; // Define initial response handler
                if(nonFoundEntities.length>0){
                    // Create handler for last element
                    let currentElementHandler = me.retrieveLastEntityHandler(nonFoundEntities[0], entities, intent);
                    // Create handler for the rest of the elements
                    for(let i=1;i<nonFoundEntities.length;i++){
                        currentElementHandler = me.retrieveEntityHandler(
                            nonFoundEntities[i], entities, intent, currentElementHandler);
                    }
                    initialResponseHandler = currentElementHandler;
                }
                else{
                    // Define conversation handler with the response
                    initialResponseHandler = me.retrieveNoRequiredEntityHandler(entities, intent);

                }
                // Start the conversation
                if(initialResponseHandler && typeof initialResponseHandler==='function'){
                    bot.startConversation(message, initialResponseHandler);
                }
            });
        });
    }

    retrieveLastEntityHandler(currentEntity, entities, intent){
        var me = this;
        var responseHandler = (currentEntity, userResponse, entities, intent, convo) => {
            // Create query
            me.fillEntity(currentEntity.column, userResponse, entities);
            let sqlQuery = me.createSQLQuery(entities, intent);
            // Execute query
            this.executeSQLQuery(sqlQuery, (results) => {
                // Parse responses
                let responses = me.prepareIntentResponses(results, intent);
                // Write responses to the user
                for(let i=0;i<responses.length;i++){
                    convo.say(responses[i]);
                }
                // Finish answer process
                convo.next();
            });
        };
        return (response, convo, updatedEntities) => {
            if(updatedEntities){
                entities = updatedEntities;
            }
            // Ask Question
            me.prepareQuestion(currentEntity, intent.sourceTable, (botQuestion) => {
                convo.ask(botQuestion, (response, convo) => {
                    // Retrieve response
                    let userResponse = response.text;
                    // Check if element exists in table (if not, send suggestions and re-ask)
                    me.checkValueExistsInDatabase(currentEntity.column, userResponse, currentEntity.function, intent.sourceTable,
                        (exists) => {
                            if(exists){
                                responseHandler(currentEntity, userResponse, entities, intent, convo);
                            }
                            else{
                                // Repeat question
                                me.prepareRepeatQuestion(currentEntity, intent.sourceTable, userResponse,
                                    (botRepeatQuestion) => {
                                        convo.ask(botRepeatQuestion, me.retrieveRepeatQuestionHandler(
                                            currentEntity, entities, intent, responseHandler
                                        ));
                                        convo.next();
                                    });
                            }
                        });
                });
            });

        };
    }

    retrieveRepeatQuestionHandler(currentEntity, entities, intent, responseCallback) {
        var me = this;
        return (response, convo, updatedEntities) => {
            // Entities chaining
            if(updatedEntities){
                entities = updatedEntities;
            }
            // Retrieve response
            let userResponse = response.text;
            // Check if element exists in table (if not, send suggestions and re-ask)
            me.checkValueExistsInDatabase(
                currentEntity.column, userResponse, currentEntity.function, intent.sourceTable,
                (exists) => {
                    if(exists){
                        // Execute callback
                        responseCallback(currentEntity, userResponse, entities, intent, convo);
                    }
                    else{
                        console.log('Elements not exists');
                        me.prepareRepeatQuestion(currentEntity, intent.sourceTable, userResponse,
                            (botRepeatQuestion) => {
                            convo.ask(botRepeatQuestion, me.retrieveRepeatQuestionHandler(
                                currentEntity, entities, intent, responseCallback
                            ));
                            convo.next();
                            });
                    }
                });
        }
    }

    retrieveEntityHandler(currentEntity, entities, intent, nextEntityCallback){
        var me = this;
        var responseHandler = (currentEntity, response, entities, intent, convo) => {
            // Create query
            me.fillEntity(currentEntity.column, response, entities);
            // Call next entity handler
            nextEntityCallback(response, convo, entities);
            convo.next();
        };
        return (response, convo, updatedEntities) => {
            // Entities chaining
            if(updatedEntities){
                entities = updatedEntities;
            }
            // Ask Question
            me.prepareQuestion(currentEntity, intent.sourceTable, (botQuestion) => {
                convo.ask(botQuestion, (response, convo) => {
                    // Retrieve response
                    let userResponse = response.text;
                    // Check if element exists in table (if not, send suggestions and re-ask)
                    me.checkValueExistsInDatabase(currentEntity.column, userResponse, currentEntity.function, intent.sourceTable,
                        (exists) => {
                            if(exists){
                                responseHandler(currentEntity, userResponse, entities, intent, convo);
                            }
                            else{
                                // Prepare question to repeat
                                me.prepareRepeatQuestion(currentEntity, intent.sourceTable, userResponse,
                                    (botRepeatQuestion) => {
                                        convo.ask(botRepeatQuestion, me.retrieveRepeatQuestionHandler(
                                            currentEntity, entities, intent, responseHandler
                                        ));
                                        convo.next();
                                    });
                            }
                        });
                });
            });
        };
    }

    retrieveNoRequiredEntityHandler(entities, intent) {
        var me = this;
        return (response, convo) => {
            // Create query
            var sqlQuery = this.createSQLQuery(entities, intent);
            // Execute query
            this.executeSQLQuery(sqlQuery, (results) => {
                // Parse responses
                let responses = me.prepareIntentResponses(results, intent);
                // Write responses to the user
                for(let i=0;i<responses.length;i++){
                    convo.say(responses[i]);
                }
                // Finish answer process
                convo.next();
            });
        }
    }

    prepareIntentResponses(results, intent){
        let resultMessages = [];
        // Prepare response
        let responses = this.parseQueryResults(results, intent.response);
        // Response with output
        if(responses.length>0){
            for(let i=0;i<responses.length;i++){
                resultMessages.push(responses[i]);
            }
        }
        else{
            if(intent.response.customNoResultsFoundMessage){
                resultMessages.push(intent.response.customNoResultsFoundMessage);
            }
            else{
                resultMessages.push('Results not found');
            }
        }
        return resultMessages;
    }

    createSQLQuery(entities, intent){
        // Construct where condition based on entities
        let whereCondition = "";
        // Create where condition with AND operand
        for(let i=0;i<entities.length-1;i++){
            whereCondition += " "+this.whereConditionParsing(entities[i].column, entities[i].function, entities[i].value)+" AND";
        }
        // Create last condition of where
        whereCondition += " "+this.whereConditionParsing(entities[entities.length-1].column, entities[entities.length-1].function, entities[entities.length-1].value);
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
                console.log("Found entity "+remainEntities[i].column+" with value "+remainEntities[i].value);
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

    checkEntitiesExistenceInDatabase(entities, sourceTable, callback) {
        let promises = [];
        for(let i=0;i<entities.length;i++){
            promises.push(new Promise((resolve, reject) => {
                this.checkValueExistsInDatabase(entities[i].column, entities[i].value, entities[i].function, sourceTable,
                    (exists) => {
                        if(!exists){
                            entities[i].value = null;
                        }
                        resolve();
                    }
                );
            }));
        }
        Promise.all(promises).then(()=>{
            callback(entities);
        });
    }

    checkValueExistsInDatabase(column, value, operand, sourceTable, callback) {
        let whereCondition = this.whereConditionParsing(column, operand, value);
        let sqlQuery = this.parseQuery(
            'SELECT COUNT(*) AS number FROM %s WHERE %s',
            sourceTable,
            whereCondition);
        this.executeSQLQuery(sqlQuery, (result) => {
            if(callback && typeof callback==='function'){
                callback(result[0].number > 0);
            }
        });
    }

    parseQuery(str){
        var args = [].slice.call(arguments, 1),
            i = 0;

        return str.replace(/%s/g, function() {
            return args[i++];
        });
    }

    parseStringArray(strArray){
        return this.parseQuery.apply(null, strArray);
    }

    executeSQLQuery(sqlQuery, callback) {
        // TODO Sanitize SQL Query (avoid SQL injection)
        // Update tabular data if is async data
        let queryTable = this.extractTableFromSQLQuery(sqlQuery);
        let queryTableSchema = this.retrieveTableSchema(queryTable);
        if(queryTableSchema){
            this.updateTable(queryTableSchema, () => {
                // Execute alasql query
                if(callback && typeof callback==='function'){
                    console.log('Executed SQL: '+sqlQuery);
                    callback(this.model.tabularData.alasql(sqlQuery));
                }
            });
        }
    }

    retrieveTableSchema(tableName){
        for(let i=0;i<this.model.schema.tabularData.length;i++){
            if(this.model.schema.tabularData[i].tableName===tableName){
                return this.model.schema.tabularData[i];
            }
        }
    }

    extractTableFromSQLQuery(sqlQuery){
        let re = /FROM\s+([^ ,]+)(?:\s*,\s*([^ ,]+))*\s*/;
        let str = sqlQuery;
        let m;
        if ((m = re.exec(str)) !== null) {
            if (m.index === re.lastIndex) {
                re.lastIndex++;
            }
            // View your result using the m-variable.
            // eg m[0] etc.
        }
        return m[1];
    }

    parseQueryResults(results, definedResponse) {
        var responses = [];
        // If is defined the number of responses, set it, in other case, set default number of responses
        let numberOfResponses = definedResponse.numberOfResponses || this.params.defaultNumberOfResponses;
        for(let i=0;i<numberOfResponses;i++){
            if(results[i]){
                // Check if is defined a custom message format
                if(definedResponse.customResponseStructure){
                    let responseStructure = definedResponse.customResponseStructure;
                    let responseStructureArray = [];
                    // First element of array is message to be parsed
                    responseStructureArray.push(responseStructure[0]);
                    for(let j=1;j<responseStructure.length;j++){
                        // Extract value of column
                        responseStructureArray.push(results[i][responseStructure[j]]);
                    }
                    responses.push(this.parseStringArray(responseStructureArray));
                }
                else{
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
        }
        return responses;

    }

    prepareQuestion(currentEntity, sourceTable, callback){
        var me = this;
        // Retrieve suggestions
        this.retrieveSuggestions(currentEntity, sourceTable, null, (suggestions) => {
            // Prepare message
            if(callback && typeof callback==='function'){
                let message = 'Set column '+currentEntity.column+' value, for example:';
                // If custom message is defined, set as message preface
                if(currentEntity.columnQuestion){
                    message = currentEntity.columnQuestion;
                }
                message = me.parseQuestionMessage(message, suggestions);
                callback(message);
            }
        });
    }

    prepareRepeatQuestion(currentEntity, sourceTable, userResponse, callback) {
        var me = this;
        // Retrieve suggestions
        this.retrieveSuggestions(currentEntity, sourceTable, userResponse, (suggestions) => {
            // Prepare message
            if(callback && typeof callback==='function'){
                let message = 'Value not found. Try:';
                // If custom message is defined, set as message preface
                if(currentEntity.suggestionCustomMessage){
                    message = currentEntity.suggestionCustomMessage;
                }
                message = me.parseQuestionMessage(message, suggestions);
                callback(message);
            }
        });
    }

    parseQuestionMessage(message, suggestions){
        let parsedMessage = message;
        if(suggestions.length>0){
            for(let i=0;i<suggestions.length;i++){
                parsedMessage += " "+suggestions[i]+",";
            }
            parsedMessage = parsedMessage.replace(/,$/, "") + ".";
        }
        return parsedMessage;
    }

    retrieveSuggestions(currentEntity, sourceTable, userResponse, callback){
        // TODO Check in different way depending on userResponse value (give different suggestions)
        let sqlQuery = this.parseQuery(
            'SELECT DISTINCT %s FROM %s',
            currentEntity.column,
            sourceTable);
        var me = this;
        this.executeSQLQuery(sqlQuery, (results) => {
            let suggestions = [];
            for(let i=0;i<me.params.maxSuggestions;i++){
                if(results[i] && results[i][currentEntity.column]){
                    suggestions.push(results[i][currentEntity.column]);
                }
            }
            if(callback && typeof callback==='function'){
                callback(suggestions);
            }
        });
    }
}

module.exports = SheetBot;