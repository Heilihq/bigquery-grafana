import _ from 'lodash';
import ResponseParser, {ResultFormat} from './response_parser';
import BigQueryQuery from './bigquery_query';
import {compact} from "lodash-es";

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


export class BigQueryDatasource {
    id: any;
    name: any;
    jsonData: any;
    responseParser: ResponseParser;
    queryModel: BigQueryQuery;
    interval: string;
    baseUrl: string;
    url: string;
    authenticationType: string;
    projectName: string;


    /** @ngInject */
    constructor(instanceSettings, private backendSrv, private $q, private templateSrv, private timeSrv) {
        this.name = instanceSettings.name;
        this.id = instanceSettings.id;
        this.jsonData = instanceSettings.jsonData;
        this.responseParser = new ResponseParser(this.$q);
        this.queryModel = new BigQueryQuery({});
        this.baseUrl = `/bigquery/`;
        this.url = instanceSettings.url;
        this.interval = (instanceSettings.jsonData || {}).timeInterval || '1m';
        this.authenticationType = instanceSettings.jsonData.authenticationType || 'jwt';
        this.projectName = instanceSettings.jsonData.defaultProject || '';

    }

    async doRequest(url, requestId = 'requestId', maxRetries = 3) {
        return this.backendSrv
            .datasourceRequest({
                url: this.url + url,
                method: 'GET',
                requestId: requestId,
            }).then(result => {
                if (result.status !== 200) {
                    if (result.status >= 500 && maxRetries > 0) {
                        return this.doRequest(url, requestId, maxRetries - 1);
                    }
                    throw BigQueryDatasource.formatBigqueryError(result.data.error);
                }
                return result;
            }).catch(error => {
                if (maxRetries > 0) {
                    return this.doRequest(url, requestId, maxRetries - 1);
                }
                if (error.cancelled === true) {
                    return [];
                }
                console.log(error);
                throw BigQueryDatasource.formatBigqueryError(error.data.error);
            });
    }

    async doQueryRequest(query, requestId, maxRetries = 3) {
        const path = `v2/projects/${this.projectName}/queries`;
        const url = this.url + `${this.baseUrl}${path}`;
        return this.backendSrv
            .datasourceRequest({
                url: url,
                method: 'POST',
                requestId: requestId,
                data: {
                    query: query,
                    useLegacySql: false,
                },
            }).then(result => {
                if (result.status !== 200) {
                    if (result.status >= 500 && maxRetries > 0) {
                        return this.doQueryRequest(query, requestId, maxRetries - 1);
                    }
                    throw BigQueryDatasource.formatBigqueryError(result.data.error);
                }
                return result;
            }).catch(error => {
                if (maxRetries > 0) {
                    return this.doQueryRequest(query, requestId, maxRetries - 1);
                }
                if (error.cancelled === true) {
                    return [];
                }
                console.log(error);
                throw BigQueryDatasource.formatBigqueryError(error.data.error);
            });
    }

    async _waitForJobComplete(queryResults, requestId, jobId) {
        let sleepTimeMs = 100;
        console.log("New job id: ", jobId);
        const path = `v2/projects/${this.projectName}/queries/` + jobId;
        while (!queryResults.data.jobComplete) {
            await sleep(sleepTimeMs);
            sleepTimeMs *= 2;
            queryResults = await this.doRequest(`${this.baseUrl}${path}`, requestId);
            console.log('wating for job to complete ', jobId);
        }
        console.log("Job Done ", jobId);
        return queryResults;


    }

    async _getQueryResults(queryResults, rows, requestId, jobId) {
        while (queryResults.data.pageToken) {
            const path = `v2/projects/${this.projectName}/queries/` + jobId + '?pageToken=' + queryResults.data.pageToken;
            queryResults = await this.doRequest(`${this.baseUrl}${path}`, requestId);
            if (queryResults.length === 0) {
                return rows;
            }
            rows = rows.concat(queryResults.data.rows);
            console.log("getting results for: ", jobId);
        }
        return rows;

    }

    async doQuery(query, requestId, maxRetries = 1) {
        if (!query) {
            return {
                rows: null,
                schema: null
            };
        }
        let notReady = false;
        ['-- time --', '-- value --'].forEach(function (element) {
            if (query.indexOf(element) !== -1) {
                notReady = true;
            }
        });
        if (notReady) {
            return {
                rows: null,
                schema: null
            };
        }
        let queryResults = await this.doQueryRequest(query, requestId, maxRetries = 1);
        if (queryResults.length === 0) {
            return {
                rows: null,
                schema: null
            };
        }
        let jobId = queryResults.data.jobReference.jobId;
        queryResults = await this._waitForJobComplete(queryResults, requestId, jobId);
        if (queryResults.length === 0) {
            return {
                rows: null,
                schema: null
            };
        }
        let rows = queryResults.data.rows;
        let schema = queryResults.data.schema;
        rows = await this._getQueryResults(queryResults, rows, requestId, jobId);
        return {
            rows: rows,
            schema: schema
        };
    }

    interpolateVariable = (value, variable) => {
        if (typeof value === 'string') {
            if (variable.multi || variable.includeAll) {
                return BigQueryQuery.quoteLiteral(value);
            } else {
                return value;
            }
        }

        if (typeof value === 'number') {
            return value;
        }

        const quotedValues = _.map(value, v => {
            return BigQueryQuery.quoteLiteral(v);
        });
        return quotedValues.join(',');
    };

    async query(options) {
        const queries = _.filter(options.targets, target => {
            return target.hide !== true;
        }).map(target => {
            const queryModel = new BigQueryQuery(target, this.templateSrv, options.scopedVars);
            this.queryModel = queryModel;
            return {
                refId: target.refId,
                intervalMs: options.intervalMs,
                maxDataPoints: options.maxDataPoints,
                datasourceId: this.id,
                rawSql: queryModel.render(this.interpolateVariable),
                format: target.format,
            };
        });

        if (queries.length === 0) {
            return this.$q.when({data: []});
        }
        const allQueryPromise = _.map(queries, query => {
            this.queryModel.target.rawSql = query.rawSql;
            let q = this.queryModel.expend_macros(options);
            return this.doQuery(q, options.panelId + query.refId).then(response => {
                return ResponseParser.parseDataQuery(response, query.format);
            });
        });
        return this.$q.all(allQueryPromise).then((responses): any => {
            let data = [];
            for (let i = 0; i < responses.length; i++) {
                for (let x = 0; x < responses[i].length; x++) {
                    data.push(responses[i][x]);
                }
            }
            return {data: data};
        });
    }


    annotationQuery(options) {
        if (!options.annotation.rawQuery) {
            return this.$q.reject({
                message: 'Query missing in annotation definition',
            });
        }

        const query = {
            refId: options.annotation.name,
            datasourceId: this.id,
            rawSql: this.templateSrv.replace(options.annotation.rawQuery, options.scopedVars, this.interpolateVariable),
            format: 'table',
        };
        return this.backendSrv
            .datasourceRequest({
                url: '/api/tsdb/query',
                method: 'POST',
                data: {
                    from: options.range.from.valueOf().toString(),
                    to: options.range.to.valueOf().toString(),
                    queries: [query],
                },
            })
            .then(data => this.responseParser.transformAnnotationResponse(options, data));
    }

    async paginatedResults(path, dataName) {
        let queryResults = await this.doRequest(`${this.baseUrl}${path}`);
        let data = queryResults.data;
        let dataList = dataName.split(".");
        dataList.forEach(function (element) {
            data = data[element];
        });
        while (queryResults.data.nextPageToken) {
            queryResults = await this.doRequest(`${this.baseUrl}${path}` + '?pageToken=' + queryResults.data.nextPageToken);
            data = data.concat(queryResults.data.projects);
        }
        return data;
    }

    async getProjects(): Promise<ResultFormat[]> {
        const path = `v2/projects`;
        const data = await this.paginatedResults(path, "projects");
        return ResponseParser.parseProjects(data);

    }

    async getDatasets(projectName): Promise<ResultFormat[]> {
        const path = `v2/projects/${projectName}/datasets`;
        const data = await this.paginatedResults(path, "datasets");
        return ResponseParser.parseDatasets(data);
    }

    async getTables(projectName, datasetName): Promise<ResultFormat[]> {
        let path = `v2/projects/${projectName}/datasets/${datasetName}/tables`;
        const data = await this.paginatedResults(path, "tables");
        return new ResponseParser(this.$q).parseTabels(data);

    }

    async getTableFields(projectName, datasetName, tableName, filter): Promise<ResultFormat[]> {
        const path = `v2/projects/${projectName}/datasets/${datasetName}/tables/${tableName}`;
        const data = await this.paginatedResults(path, "schema.fields");
        return ResponseParser.parseTableFields(data, filter);
    }

    async getDefaultProject() {
        try {
            if (this.authenticationType === 'gce' || !this.projectName) {
                const data = await this.getProjects();
                this.projectName = data[0].value;
                return this.projectName;
            } else {
                return this.projectName;
            }
        } catch (error) {
            throw BigQueryDatasource.formatBigqueryError(error);
        }
    }

    async testDatasource() {
        let status, message;
        status = 'success';
        message = 'Successfully queried the BigQuery API.';
        const defaultErrorMessage = 'Cannot connect to BigQuery API';
        try {
            const projectName = await this.getDefaultProject();
            const path = `v2/projects/${projectName}/datasets`;
            const response = await this.doRequest(`${this.baseUrl}${path}`);
            if (response.status !== 200) {
                status = 'error';
                message = response.statusText ? response.statusText : defaultErrorMessage;
            }
        } catch (error) {
            message = error.statusText ? error.statusText : defaultErrorMessage;
            if (error.data && error.data.error && error.data.error.code) {
                message = ': ' + error.data.error.code + '. ' + error.data.error.message;
            }
        }
        return {
            status,
            message,
        };
    }

    static formatBigqueryError(error) {
        let message = 'BigQuery: ';
        let status = '';
        let data = '';
        if (error !== undefined) {
            message += error.message ? error.message : 'Cannot connect to BigQuery API';
            status = error.code;
            data = error.errors[0].reason + ": " + error.message;
        }
        return {statusText: message, status: status,data: {
                message: data,
            },};
    }
}
