'use strict';

var readline = require('readline');
var google = require('googleapis');
var googleAuth = require('google-auth-library');
var fs = require('fs');

var SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
var TOKEN_DIR = process.env.USERPROFILE+'/.credentials/';
var TOKEN_PATH = TOKEN_DIR + 'sheets.googleapis.com-nodejs-quickstart.json';

class GSheetManager{
    static init(){

    }

    static getNewToken(oauth2Client, callback){
        var authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES
        });
        console.log('Authorize this app by visiting this url: ', authUrl);
        var rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('Enter the code from that page here: ', function(code) {
            rl.close();
            oauth2Client.getToken(code, function(err, token) {
                if (err) {
                    console.log('Error while trying to retrieve access token', err);
                    return;
                }
                oauth2Client.credentials = token;
                GSheetManager.storeToken(token);
                callback(oauth2Client);
            });
        });
    }

    static storeToken(token){
        try {
            fs.mkdirSync(TOKEN_DIR);
        } catch (err) {
            if (err.code != 'EEXIST') {
                throw err;
            }
        }
        fs.writeFile(TOKEN_PATH, JSON.stringify(token));
        console.log('Token stored to ' + TOKEN_PATH);
    }

    static authorize(credentials, callback){
        var clientSecret = credentials.installed.client_secret;
        var clientId = credentials.installed.client_id;
        var redirectUrl = credentials.installed.redirect_uris[0];
        var auth = new googleAuth();
        var oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

        // Check if we have previously stored a token.
        fs.readFile(TOKEN_PATH, function(err, token) {
            if (err) {
                GSheetManager.getNewToken(oauth2Client, callback);
            } else {
                oauth2Client.credentials = JSON.parse(token);
                callback(oauth2Client);
            }
        });
    }

    static loadRawData(gSheetAuthFile, gSheetToken, gSheetName, gSheetRange, callback){
        fs.readFile(gSheetAuthFile, function processClientSecrets(err, content) {
            if (err) {
                console.log('Error loading client secret file: ' + err);
                return;
            }
            GSheetManager.authorize(JSON.parse(content), function(auth){
                GSheetManager.retrieveTabularData(auth, gSheetToken, gSheetName, gSheetRange, callback);
            });
        });
    }

    static retrieveTabularData(auth, spreadsheetId, spreadsheetName, range, callback){
        var sheets = google.sheets('v4');
        sheets.spreadsheets.values.get({
            auth: auth,
            spreadsheetId: spreadsheetId,
            range: spreadsheetName+'!'+range,
        }, function(err, response){
            if (err) {
                console.log('The API returned an error: ' + err);
                return;
            }
            var rows = response.values;
            if (rows.length == 0) {
                console.log('No data found.');
            }
            else {
                callback(response.values);
            }
        });
    }

    static compareRawData(rawData1, rawData2){
        return JSON.stringify(rawData1) == JSON.stringify(rawData2);
    }
}

module.exports = GSheetManager;