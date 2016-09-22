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
        this.loadSchema(schemaFile);

        // Defined static values
        this.params = {};
        this.params.maxSuggestions = 5;
        this.params.defaultNumberOfResponses = 1;
    }

    loadDependencies(tokenFile){
        // Properties file reader dependency
        this._PropertiesReader = require('properties-reader');
        // Read configuration file
        this.loadConfiguration(tokenFile);

        this._Botkit = require('botkit');
        this._fs = require('fs');
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

    loadSchema(schemaFile){
        // Read file
        this.model.schema = JSON.parse(this._fs.readFileSync(schemaFile, 'utf8'));

        // Load sheet data
        this.initializeTabularData(this.model.tabularData.gSheetAuthFile, this.model.schema.sheets);

        // Load intents behaviour
        this.loadGreetingsHandler(this.model.schema.chat.greetings);
        this.loadIntents(this.model.schema.chat.intents);
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
            this._configuration.get('onekin.gsheet.url'),
            tableSchema.gSheetName,
            tableSchema.gSheetRange,
            (rawTable) => {
                var tabularMetadata = {
                    'gSheetToken': this._configuration.get('onekin.gsheet.url'),
                    'gSheetName': tableSchema.gSheetName,
                    'gSheetRange': tableSchema.gSheetRange
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
            this.updateAlaSQLTable(tabularMetadata.gSheetName, formatedTable);
            console.log('Updated table: '+tabularMetadata.gSheetName);
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
            // If data conversion to an integer is NaN, then is a string
            let cellNumberIntent = Number(rawCell);
            if(isNaN(cellNumberIntent)){
                return rawCell.replace(/(\r\n|\n|\r)/gm," "); // Remove newline characters
            }
            // If data isn't NaN then is a pure integer, so it will be treated as integer
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
            me.checkEntitiesExistenceInDatabase(entities, intent.sourceSheet, (entities) => {
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
            me.fillEntity(currentEntity.inputColumn, userResponse, entities);
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
            me.prepareQuestion(currentEntity, entities, intent.sourceSheet, (botQuestion) => {
                convo.ask(botQuestion, (response, convo) => {
                    // Retrieve response
                    let userResponse = response.text;
                    // Check if element exists in table (if not, send suggestions and re-ask)
                    me.checkValueExistsInDatabase(currentEntity.inputColumn, userResponse, currentEntity.mask, entities, intent.sourceSheet,
                        (exists) => {
                            if(exists){
                                responseHandler(currentEntity, userResponse, entities, intent, convo);
                            }
                            else{
                                // Repeat question
                                me.prepareRepeatQuestion(currentEntity, entities, intent.sourceSheet, userResponse,
                                    (botRepeatQuestion) => {
                                        convo.ask(botRepeatQuestion, me.retrieveRepeatQuestionHandler(
                                            currentEntity, entities, intent, responseHandler
                                        ));
                                        convo.next();
                                    });
                            }
                        });
                });
                convo.next();
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
                currentEntity.inputColumn, userResponse, currentEntity.mask, entities, intent.sourceSheet,
                (exists) => {
                    if(exists){
                        // Execute callback
                        responseCallback(currentEntity, userResponse, entities, intent, convo);
                    }
                    else{
                        console.log('Elements not exists');
                        me.prepareRepeatQuestion(currentEntity, entities, intent.sourceSheet, userResponse,
                            (botRepeatQuestion) => {
                            convo.ask(botRepeatQuestion, me.retrieveRepeatQuestionHandler(
                                currentEntity, entities, intent, responseCallback
                            ));
                            convo.next();
                            });
                    }
                });
        };
    }

    retrieveEntityHandler(currentEntity, entities, intent, nextEntityCallback){
        var me = this;
        var responseHandler = (currentEntity, response, entities, intent, convo) => {
            // Create query
            me.fillEntity(currentEntity.inputColumn, response, entities);
            // Call next entity handler
            nextEntityCallback(response, convo, entities);
        };
        return (response, convo, updatedEntities) => {
            // Entities chaining
            if(updatedEntities){
                entities = updatedEntities;
            }
            // Ask Question
            me.prepareQuestion(currentEntity, entities, intent.sourceSheet, (botQuestion) => {
                convo.ask(botQuestion, (response, convo) => {
                    // Retrieve response
                    let userResponse = response.text;
                    // Check if element exists in table (if not, send suggestions and re-ask)
                    me.checkValueExistsInDatabase(currentEntity.inputColumn, userResponse, currentEntity.mask, entities, intent.sourceSheet,
                        (exists) => {
                            if(exists){
                                responseHandler(currentEntity, userResponse, entities, intent, convo);
                            }
                            else{
                                // Prepare question to repeat
                                me.prepareRepeatQuestion(currentEntity, entities, intent.sourceSheet, userResponse,
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
        };
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
            if(intent.response.notFoundMessage){
                resultMessages.push(intent.response.notFoundMessage);
            }
            else{
                resultMessages.push('Results not found');
            }
        }
        return resultMessages;
    }

    createSQLQuery(entities, intent){
        // Construct where condition based on entities
        let whereCondition = '';
        // Create where condition with AND operand
        for(let i=0;i<entities.length;i++){
            whereCondition += ' '+this.whereConditionParsing(entities[i].inputColumn, entities[i].mask, entities[i].value)+' AND';
        }
        // Create last condition of where
        whereCondition = whereCondition.slice(0, -4);
        let sqlQuery = this.parseQuery('SELECT %s FROM %s WHERE %s',
            intent.response.outputColumn,
            intent.sourceSheet,
            whereCondition);
        return sqlQuery;
    }

    createWhereConditionBasedOnDefinedEntities(entities){
        let whereCondition = '';
        for(let i=0;i<entities.length;i++){
            if(entities[i].value){
                whereCondition += ' '+this.whereConditionParsing(entities[i].inputColumn, entities[i].mask, entities[i].value)+' AND';
            }
        }
        return whereCondition.slice(0, -4);
    }

    whereConditionParsing(column, operand, value){
        const parsingMethods = {
            'LIKE' : (value) => {
                return '"%'+value+'%"';
            },
            '=' : (value) => {
                return  '"'+value+'"';
            },
            '!=': (value) => {
                return  '"'+value+'"';
            },
            '>': (value) => {
                return  '"'+value+'"';
            },
            '>=': (value) => {
                return  '"'+value+'"';
            },
            '<': (value) => {
                return  '"'+value+'"';
            },
            '<=': (value) => {
                return  '"'+value+'"';
            },
            '!<': (value) => {
                return  '"'+value+'"';
            },
            '!>': (value) => {
                return  '"'+value+'"';
            }
        };
        // For OR Entities
        if(Array.isArray(column)){
            let whereCondition = '';
            for(let i=0;i<column.length;i++){
                whereCondition += column[i]+' '+operand+' '+parsingMethods[operand](value)+' AND '+column[i]+'<>"" OR ';
            }
            return whereCondition.slice(0, -3);
        }
        else{
            if(parsingMethods[operand]){
                return column+' '+operand+' '+parsingMethods[operand](value)+' AND '+column+'<>""';
            }
            else{
                return column+' = '+value;
            }
        }
    }

    fillEntities(definedEntities, foundEntities) {
        var remainEntities = JSON.parse(JSON.stringify(definedEntities));
        for(let i=0; i<remainEntities.length;i++){
            if(Array.isArray(definedEntities[i].inputColumn)){
                if(foundEntities[definedEntities[i].inputColumn[0].toLowerCase()]){
                    remainEntities[i].value = foundEntities[definedEntities[i].inputColumn[0].toLowerCase()][0].value;
                    console.log('Found multi-column entity '+remainEntities[i].inputColumn[0]+' with value '+remainEntities[i].value);
                }
            }
            else if(foundEntities[definedEntities[i].inputColumn.toLowerCase()]){
                remainEntities[i].value = foundEntities[definedEntities[i].inputColumn.toLowerCase()][0].value;
                console.log('Found entity '+remainEntities[i].inputColumn+' with value '+remainEntities[i].value);
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
            if(entities[i].inputColumn.toLowerCase()===column.toLowerCase()){
                entities[i].value = value;
            }
        }
    }

    startBot(){
        this.model.bot.startRTM(function(err) {
            if (err) {
                throw new Error('Could not connect to Slack');
            }
        });
    }

    loadGreetingsHandler(responseMessage) {
        this.model.botController.hears(['greetings'], 'direct_message,direct_mention,mention', this._wit.hears, function(bot, message){
            bot.reply(message, responseMessage);
        });
    }

    checkEntitiesExistenceInDatabase(entities, sourceTable, callback) {
        let promises = [];
        for(let i=0;i<entities.length;i++){
            promises.push(new Promise((resolve) => {
                this.checkValueExistsInDatabase(entities[i].inputColumn, entities[i].value, entities[i].mask, entities, sourceTable,
                    (exists) => {
                        if(!exists){
                            if(entities[i].value){
                                entities[i].tried = true;
                            }
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

    checkValueExistsInDatabase(column, value, operand, entities, sourceTable, callback) {
        let whereCondition = this.whereConditionParsing(column, operand, value);
        let sqlQuery = this.parseQuery(
            'SELECT COUNT(*) AS number FROM %s WHERE %s',
            sourceTable,
            whereCondition);
        let previousEntitiesWhereStatement = this.createWhereConditionBasedOnDefinedEntities(entities);
        if(previousEntitiesWhereStatement!==''){
            sqlQuery += ' AND '+previousEntitiesWhereStatement;
        }

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
        for(let i=0;i<this.model.schema.sheets.length;i++){
            if(this.model.schema.sheets[i].gSheetName===tableName){
                return this.model.schema.sheets[i];
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
                    let response = '';
                    let outputColumns = Object.keys(results[i]);
                    for(let j=0;j<outputColumns.length;j++){
                        if(definedResponse.showColumnName){
                            response += outputColumns[j]+': '+results[i][outputColumns[j]]+'\n';
                        }
                        else{
                            response += results[i][outputColumns[j]]+'\n';
                        }
                    }
                    responses.push(response);
                }
            }
        }
        return responses;

    }

    prepareQuestion(currentEntity, entities, sourceTable, callback){
        var me = this;
        // Retrieve suggestions
        this.retrieveSuggestions(currentEntity, entities, sourceTable, null, (suggestions) => {
            // Prepare message
            if(callback && typeof callback==='function'){
                let message = 'Set column '+currentEntity.inputColumn+' value, for example:';
                // Check if user tried to set value of this message before
                if(currentEntity.tried){
                    // If custom message is defined, set as message preface
                    if(currentEntity.entityNotFoundMessage){
                        message = currentEntity.entityNotFoundMessage;
                    }
                }
                else{
                    // If custom message is defined, set as message preface
                    if(currentEntity.entityMissingMessage){
                        message = currentEntity.entityMissingMessage;
                    }
                }
                message = me.parseQuestionMessage(message, suggestions);
                callback(message);
            }
        });
    }

    prepareRepeatQuestion(currentEntity, entities, sourceTable, userResponse, callback) {
        var me = this;
        // Retrieve suggestions
        this.retrieveSuggestions(currentEntity, entities, sourceTable, userResponse, (suggestions) => {
            // Prepare message
            if(callback && typeof callback==='function'){
                let message = 'Value not found. Try:';
                // If custom message is defined, set as message preface
                if(currentEntity.entityNotFoundMessage){
                    message = currentEntity.entityNotFoundMessage;
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
                parsedMessage += ' '+suggestions[i]+',';
            }
            parsedMessage = parsedMessage.replace(/,$/, '') + '.';
        }
        return parsedMessage;
    }

    retrieveSuggestions(currentEntity, entities, sourceTable, userResponse, callback){
        // TODO Check in different way depending on userResponse value (give different suggestions)
        // Set query SELECT and FROM
        let targetColumn = null;
        if(Array.isArray(currentEntity.inputColumn)){
            targetColumn = currentEntity.inputColumn[0];
        }
        else{
            targetColumn = currentEntity.inputColumn;
        }
        let sqlQuery = this.parseQuery(
            'SELECT DISTINCT %s FROM %s',
            targetColumn,
            sourceTable);
        // Add previous set entities conditions to WHERE statement
        let previousEntitiesWhereStatement = this.createWhereConditionBasedOnDefinedEntities(entities);
        if(previousEntitiesWhereStatement!==''){
            sqlQuery += ' WHERE '+previousEntitiesWhereStatement;
        }
        var me = this;
        this.executeSQLQuery(sqlQuery, (results) => {
            // Randomize results
            let shuffledResults = me.shuffleArray(results);
            // Prepare suggestions
            let suggestions = [];
            for(let i=0;i<me.params.maxSuggestions;i++){
                if(shuffledResults[i] && shuffledResults[i][targetColumn]){
                    suggestions.push(shuffledResults[i][targetColumn]);
                }
            }
            if(callback && typeof callback==='function'){
                callback(suggestions);
            }
        });
    }

    shuffleArray(originalArray) {
        let array = JSON.parse(JSON.stringify(originalArray));
        for (var i = array.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
        return array;
    }
}

module.exports = SheetBot;