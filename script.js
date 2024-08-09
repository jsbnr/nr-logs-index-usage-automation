//Queries

// select latest(LogIndexUsage), latest(LogIndexUsagePercent), latest(threshold), latest(breaching) from Metric facet indexName since 1 day ago
// select  max(LogIndexUsagePercent) from Metric facet indexName since 7 day ago timeseries


const SOURCE_USER_KEY="NRAK..."; //Source account USER api key (please use a secure cred!)
const SOURCE_ACCOUNT_ID="0"; //source account ID
const SOURCE_ACCOUNT_NAME="account name here"; // source account name
const DEST_INSERT_KEY = "...FFFFNRAL"; //Destination account INGEST api key (please use a secure cred!)


const LOOKUP_TABLE_NAME="AutoLogThresholds";
const LOOKUP_INDEX_KEY_NAME="indexName";
const DEFAULT_INDEX_THRESHOLD=30;
const QUERY_FIELD_NAME="value"
const SOURCE_INDEX_QUERY=`FROM Log select count(*) as ${QUERY_FIELD_NAME} facet container_name as ${LOOKUP_INDEX_KEY_NAME} limit max since 1 day ago`; 

const AUTO_UPDATE_LOOKUP = true; // update the lookup table with new found indexes?

const REGION="US"; //EU or US
const DEFAULT_TIMEOUT = 15000   // default timeout for queries, in ms


// End Configuration ---------------------------------------------------------------

const LOOKUP_DOMAIN= REGION =="EU" ? "nrql-lookup.service.eu.newrelic.com" : "nrql-lookup.service.newrelic.com";
const GRAPHQL_ENDPOINT = REGION === "EU" ? "api.eu.newrelic.com" : "api.newrelic.com" ;
const INGEST_METRIC_ENDPOINT = REGION === "EU" ? "metric-api.eu.newrelic.com" : "metric-api.newrelic.com";
const SOURCE_NAME="AutoLogCheck";

let assert = require('assert');

let RUNNING_LOCALLY = false

/*
*  ========== LOCAL TESTING CONFIGURATION ===========================
*  This section allows you to run the script from your local machine
*  mimicking it running in the new relic environment. Much easier to develop!
*/

const IS_LOCAL_ENV = typeof $http === 'undefined';
if (IS_LOCAL_ENV) {  
  RUNNING_LOCALLY=true
  var $http = require("request");
  console.log("Running in local mode",true)
} 


// Some useful helper functions

/*
* asyncForEach()
*
* A handy version of forEach that supports await.
* @param {Object[]} array     - An array of things to iterate over
* @param {function} callback  - The callback for each item
*/
async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}
  
/*
* isObject()
*
* A handy check for if a var is an object
*/
function isObject(val) {
    if (val === null) { return false;}
    return ( (typeof val === 'function') || (typeof val === 'object') );
}

/*
* genericServiceCall()
* Generic service call helper for commonly repeated tasks
*
* @param {number} responseCodes  - The response code (or array of codes) expected from the api call (e.g. 200 or [200,201])
* @param {Object} options       - The standard http request options object
* @param {function} success     - Call back function to run on successfule request
*/
const  genericServiceCall = function(responseCodes,options,success) {
    !('timeout' in options) && (options.timeout = DEFAULT_TIMEOUT) //add a timeout if not already specified 
    let possibleResponseCodes=responseCodes
    if(typeof(responseCodes) == 'number') { //convert to array if not supplied as array
      possibleResponseCodes=[responseCodes]
    }
    return new Promise((resolve, reject) => {
        $http(options, function callback(error, response, body) {
        if(error) {
            console.log(`Error: Connection error on url '${options.url}'`);
            reject(`Connection error on url '${options.url}'`)
        } else {
            if(!possibleResponseCodes.includes(response.statusCode)) {
                let errmsg=`Expected [${possibleResponseCodes}] response code but got '${response.statusCode}' from url '${options.url}'`
                reject(errmsg)
            } else {
                resolve(success(body,response,error))
            }
          }
        });
    })
  }

/*
* setAttribute()
* Sets a custom attribute on the synthetic record
*
* @param {string} key               - the key name
* @param {Strin|Object} value       - the value to set
*/
const setAttribute = function(key,value) {
    if(!RUNNING_LOCALLY) { //these only make sense when running on a minion
        $util.insights.set(key,value)
    } else {
        //log(`Set attribute '${key}' to ${value}`)
    }
}


/*
* sendDataToNewRelic()
* Sends a metrics payload to New Relic
*
* @param {object} data               - the payload to send
*/
const sendDataToNewRelic = async (data) =>  {
    let request = {
        url: `https://${INGEST_METRIC_ENDPOINT}/metric/v1`,
        method: 'POST',
        headers :{
            "Api-Key": DEST_INSERT_KEY
        },
        body: JSON.stringify(data)
    }
    //log(`Sending ${data[0].metrics.length} records to NR metrics API...`)

    return genericServiceCall([200,202],request,(body,response,error)=>{
        if(error) {
            console.log(`NR Post failed : ${error} `,true)
            return false
        } else {
            return true
        }
    })
}


//Parse a GQL response object
const JSONParseGraphQLResponse = (data) => {
    try {
       if(isObject(data)) {
           return data
       } else {
           return JSON.parse(data)
       }        
   } catch(e){
       console.log("JSON parse failed")
       throw e;
   }
}

// Send NRQL query to NR
const queryNRQL = async (accountId,apiKey,query) => {
    const graphQLQuery=`{ actor { account(id: ${accountId}) { nrql(query: "${query}") { results metadata { facets } } } } }  `
    const options =  {
        url: `https://${GRAPHQL_ENDPOINT}/graphql`,
        method: 'POST',
        headers :{
            "Content-Type": "application/json",
            "API-Key": apiKey
        },
        body: JSON.stringify({ "query": graphQLQuery})
    };

    try {
        const response = await genericServiceCall([200],options,(body)=>{return body})
        const responseObject = JSONParseGraphQLResponse(response);
        if(responseObject?.errors && responseObject?.errors.length > 0) {
            console.log("GraphQL Errors",responseObject?.errors);
            throw responseObject?.errors;
        }
        return responseObject;
    } catch(e) {
        throw e
    }
}


// Get lookup table data
// https://docs.newrelic.com/docs/apis/lookups-service-api/lookups-service-api/

const getLookupTable = async (accountId,tableName,apiKey) =>  {
    let request = {
        url: `https://${LOOKUP_DOMAIN}/v1/accounts/${accountId}/${tableName}?includeTable=true`,
        method: 'GET',
        headers :{
            "Api-Key": apiKey
        }
    }
    try {
        const response = await genericServiceCall([200],request,(body)=>{return JSONParseGraphQLResponse(body)});
        console.log("Lookup table:",response.table);
        return response.table;
    } catch(e) {
        throw e;
    }
}


const updateLookupTable = async (accountId,tableName,apiKey,tableData) =>  {
    let request = {
        url: `https://${LOOKUP_DOMAIN}/v1/accounts/${accountId}/${tableName}`,
        method: 'PUT',
        headers :{
            "Api-Key": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ table: tableData })
    }
    try {
        let statusCode = await genericServiceCall([200],request,(body,response)=>{return response.statusCode});
        console.log("Update response",statusCode);
    } catch(e) {
        throw e;
    }
}

const discoverIndexes = async (lookupTableData,reportingIndexes) => {
    //expected table format:  'indexName', 'threshold', 'type' ]

    const knownIndexes=lookupTableData.rows.map((r)=>r[0]); // create a list of the indexes
    const unknownIndexes=reportingIndexes.filter((i)=>{return !knownIndexes.includes(i[LOOKUP_INDEX_KEY_NAME])}); //remove all the indexes we know about that are already in the lookup table

    //For unknown indexes we need to add to lookup table and re-upload.
    let dicoveredIndexes=false;
    if(unknownIndexes.length > 0) {
        console.log("New indexes were discovered", unknownIndexes.map((i)=>{return i.indexName}));
        unknownIndexes.forEach((i)=>{
            lookupTableData.rows.push([i[LOOKUP_INDEX_KEY_NAME], DEFAULT_INDEX_THRESHOLD, "auto-default"]);
        });
        dicoveredIndexes=true;
    }
    return  dicoveredIndexes;
}


const gatherIndexInformation = async (accountId,apiKey, query) => {
  
        let reponse = await queryNRQL(accountId,apiKey, query);
        const indexData = reponse?.data?.actor?.account?.nrql?.results;
        if(indexData ) {
            console.log(`Loaded ${indexData.length} indexes`);
            return indexData;
        } else {
            return [];
        }
        
    
}

// process all the indexes 
const analyzeIndexes = async (lookupTableData,indexData) => {

    let metrics=[];
    const timestamp = Date.now();
    let breachingCount=0;
  
    indexData.forEach((index)=>{
        const threshold=lookupTableData.rows.find((data)=>{return data[0]==index[LOOKUP_INDEX_KEY_NAME]})[1];
        const value = index[QUERY_FIELD_NAME];
        const percentOfThreshold = (value / threshold) * 100;
        if(percentOfThreshold >= 100) { breachingCount++; }
        const breaching = percentOfThreshold >= 100 ? true : false;
        console.log(`Index '${index[LOOKUP_INDEX_KEY_NAME]}' has threshold: ${threshold}, value: ${value}, percent: ${percentOfThreshold.toFixed(2)}% ${breaching ? '[Breaching]':'[OK]'}`);

        
        metrics.push({
            name: `LogIndexUsagePercent`,
            type: "gauge",
            value: percentOfThreshold,
            timestamp: timestamp,
            attributes: {
                indexName: index[LOOKUP_INDEX_KEY_NAME],
                breaching: breaching,
                threshold: threshold
                
            }
        });
        metrics.push({
            name: `LogIndexUsage`,
            type: "gauge",
            value: value,
            timestamp: timestamp,
            attributes: {
                indexName: index[LOOKUP_INDEX_KEY_NAME],
                breaching: breaching,
                threshold: threshold
            }
        });

    });
    console.log(`\n${breachingCount}/${indexData.length} index(es) are breaching thresholds.`)

    let commonMetricBlock={"attributes": {}}
    commonMetricBlock.attributes[`source`]=SOURCE_NAME;
    commonMetricBlock.attributes[`sourceAccountId`]=SOURCE_ACCOUNT_ID;
    commonMetricBlock.attributes[`sourceAccountName`]=SOURCE_ACCOUNT_NAME;
    let metricsPayLoad=[{ 
        "common" : commonMetricBlock,
        "metrics": metrics
    }];

    console.log("Sending metric data to New Relic:")
    await sendDataToNewRelic(metricsPayLoad);

}


/*
*  ========== RUN ===========================
*/

async function run() {
    const currentLookupTable = await getLookupTable(SOURCE_ACCOUNT_ID,LOOKUP_TABLE_NAME,SOURCE_USER_KEY);
    // const currentLookupTable={ //test data!
    //     headers: [ 'indexName', 'threshold', 'type' ],
    //     rows: [ [ 'example1', 30, 'manual' ],[ 'example2', 88, 'manual' ] ]
    //   };

    // Grab unique indexes and current values from nrql query
    const reportingIndexes = await gatherIndexInformation(SOURCE_ACCOUNT_ID, SOURCE_USER_KEY,SOURCE_INDEX_QUERY);
    //const reportingIndexes = ['example1', 'example2', 'newFour', 'newFive'];

    //Look for new indexes and if so update lookup table accordingly.
    const discoveredIndexes = await discoverIndexes(currentLookupTable,reportingIndexes);

    if(AUTO_UPDATE_LOOKUP && discoveredIndexes && currentLookupTable.rows.length > 0) {
        console.log(`Updating lookup table ${LOOKUP_TABLE_NAME} with newly found index thresholds...`);
        await updateLookupTable(SOURCE_ACCOUNT_ID,LOOKUP_TABLE_NAME,SOURCE_USER_KEY,currentLookupTable);
    }

    console.log("\nSending metric data to New Relic")
    await analyzeIndexes(currentLookupTable,reportingIndexes);

    console.log("We're done!");

}

try {
    console.log("Startup")
    run();
    
} catch(e) {
    console.log("Unexpected errors: ",e)
}