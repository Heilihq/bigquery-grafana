import _ from 'lodash';
import appEvents from 'grafana/app/core/app_events';
import {QueryCtrl} from 'grafana/app/plugins/sdk';
import {SqlPart} from './sql_part';
import BigQueryQuery from './bigquery_query';
import sqlPart from './sql_part';

export interface QueryMeta {
    sql: string;
}

const defaultQuery = `SELECT
  $__time(time_column),
  value1
FROM
  metric_table
WHERE
  $__timeFilter(time_column)
`;

export class BigQueryQueryCtrl extends QueryCtrl {
    static templateUrl = 'partials/query.editor.html';
    formats: any[];
    queryModel: BigQueryQuery;
    lastQueryMeta: QueryMeta;
    lastQueryError: string;
    showHelp: boolean;
    projectSegment: any;
    datasetSegment: any;
    tableSegment: any;
    whereAdd: any;
    timeColumnSegment: any;
    metricColumnSegment: any;
    selectMenu: any[];
    selectParts: SqlPart[][];
    groupParts: SqlPart[];
    whereParts: SqlPart[];
    groupAdd: any;

    /** @ngInject */
    constructor($scope, $injector, private templateSrv, private $q, private uiSegmentSrv) {
        super($scope, $injector);
        this.queryModel = new BigQueryQuery(this.target, templateSrv, this.panel.scopedVars);
        this.updateProjection();
        this.formats = [{text: 'Time series', value: 'time_series'}, {text: 'Table', value: 'table'}];
        if (!this.target.rawSql) {
            // special handling when in table panel
            if (this.panelCtrl.panel.type === 'table') {
                this.target.format = 'table';
                this.target.rawSql = 'SELECT 1';
                this.target.rawQuery = true;
            } else {
                this.target.rawSql = defaultQuery;
            }
        }

        if (!this.target.project) {
            this.projectSegment = uiSegmentSrv.newSegment({value: 'select project', fake: true});
        } else {
            this.projectSegment = uiSegmentSrv.newSegment(this.target.project);
        }

        if (!this.target.dataset) {
            this.datasetSegment = uiSegmentSrv.newSegment({value: 'select dataset', fake: true});
        } else {
            this.datasetSegment = uiSegmentSrv.newSegment(this.target.dataset);
        }

        if (!this.target.table) {
            this.tableSegment = uiSegmentSrv.newSegment({value: 'select table', fake: true});
        } else {
            this.tableSegment = uiSegmentSrv.newSegment(this.target.table);
        }

        this.timeColumnSegment = uiSegmentSrv.newSegment(this.target.timeColumn);
        this.metricColumnSegment = uiSegmentSrv.newSegment(this.target.metricColumn);

        this.buildSelectMenu();
        this.whereAdd = this.uiSegmentSrv.newPlusButton();
        this.groupAdd = this.uiSegmentSrv.newPlusButton();
        this.panelCtrl.events.on('data-received', this.onDataReceived.bind(this), $scope);
        this.panelCtrl.events.on('data-error', this.onDataError.bind(this), $scope);
    }

    updateProjection() {
        this.selectParts = _.map(this.target.select, (parts: any) => {
            return _.map(parts, sqlPart.create).filter(n => n);
        });
        this.whereParts = _.map(this.target.where, sqlPart.create).filter(n => n);
        this.groupParts = _.map(this.target.group, sqlPart.create).filter(n => n);
    }

    updatePersistedParts() {
        this.target.select = _.map(this.selectParts, selectParts => {
            return _.map(selectParts, (part: any) => {
                return {type: part.def.type, datatype: part.datatype, params: part.params};
            });
        });
        this.target.where = _.map(this.whereParts, (part: any) => {
            return {type: part.def.type, datatype: part.datatype, name: part.name, params: part.params};
        });
        this.target.group = _.map(this.groupParts, (part: any) => {
            return {type: part.def.type, datatype: part.datatype, params: part.params};
        });
    }

    buildSelectMenu() {
        this.selectMenu = [];
        const aggregates = {
            text: 'Aggregate Functions',
            value: 'aggregate',
            submenu: [
                {text: 'Average', value: 'avg'},
                {text: 'Count', value: 'count'},
                {text: 'Maximum', value: 'max'},
                {text: 'Minimum', value: 'min'},
                {text: 'Sum', value: 'sum'},
                {text: 'Standard deviation', value: 'stddev'},
                {text: 'Variance', value: 'variance'},
            ],
        };

        // first and last aggregate are timescaledb specific
        if (this.datasource.jsonData.timescaledb === true) {
            aggregates.submenu.push({text: 'First', value: 'first'});
            aggregates.submenu.push({text: 'Last', value: 'last'});
        }

        this.selectMenu.push(aggregates);

        // ordered set aggregates require postgres 9.4+
        if (this.datasource.jsonData.postgresVersion >= 904) {
            const aggregates2 = {
                text: 'Ordered-Set Aggregate Functions',
                value: 'percentile',
                submenu: [
                    {text: 'Percentile (continuous)', value: 'percentile_cont'},
                    {text: 'Percentile (discrete)', value: 'percentile_disc'},
                ],
            };
            this.selectMenu.push(aggregates2);
        }

        const windows = {
            text: 'Window Functions',
            value: 'window',
            submenu: [
                {text: 'Delta', value: 'delta'},
                {text: 'Increase', value: 'increase'},
                {text: 'Rate', value: 'rate'},
                {text: 'Sum', value: 'sum'},
                {text: 'Moving Average', value: 'avg', type: 'moving_window'},
            ],
        };
        this.selectMenu.push(windows);

        this.selectMenu.push({text: 'Alias', value: 'alias'});
        this.selectMenu.push({text: 'Column', value: 'column'});
    }

    toggleEditorMode() {
        if (this.target.rawQuery) {
            appEvents.emit('confirm-modal', {
                title: 'Warning',
                text2: 'Switching to query builder may overwrite your raw SQL.',
                icon: 'fa-exclamation',
                yesText: 'Switch',
                onConfirm: () => {
                    this.target.rawQuery = !this.target.rawQuery;
                },
            });
        } else {
            this.target.rawQuery = !this.target.rawQuery;
        }
    }

    resetPlusButton(button) {
        const plusButton = this.uiSegmentSrv.newPlusButton();
        button.html = plusButton.html;
        button.value = plusButton.value;
    }

    getProjectSegments() {
        return this.datasource.getProjects()
            .then(this.uiSegmentSrv.transformToSegments(false))
            .catch(this.handleQueryError.bind(this));
    }

    projectChanged() {
        this.target.project = this.projectSegment.value;
        this.datasource.projectName = this.projectSegment.value;
        this.target.dataset = '';
        this.applySegment(this.datasetSegment, this.fakeSegment('select dataset'));
        this.applySegment(this.tableSegment, this.fakeSegment('select table'));
        this.applySegment(this.timeColumnSegment, this.fakeSegment('-- time --'));

    }

    getDatasetSegments() {
        return this.datasource.getDatasets(this.target.project)
            .then(this.uiSegmentSrv.transformToSegments(false))
            .catch(this.handleQueryError.bind(this));
    }

    datasetChanged() {
        this.target.dataset = this.datasetSegment.value;
        this.target.sharded = false;
        this.applySegment(this.tableSegment, this.fakeSegment('select table'));
        this.applySegment(this.timeColumnSegment, this.fakeSegment('-- time --'));
    }

    getTableSegments() {
        return this.datasource.getTables(this.target.project, this.target.dataset)
            .then(this.uiSegmentSrv.transformToSegments(false))
            .catch(this.handleQueryError.bind(this));
    }

    tableChanged() {
        this.target.sharded = false;
        this.target.table = this.tableSegment.value;
        this.applySegment(this.timeColumnSegment, this.fakeSegment('-- time --'));
        let sharded = this.target.table.indexOf("_YYYYMMDD");
        if (sharded > -1) {
            this.target.table = this.target.table.substring(0, sharded + 1) + "*";
            this.target.sharded = true;
        }

        this.target.where = [];
        this.target.group = [];
        this.target.select = [[{type: 'column', params: ['-- value --']}]];
        this.updateProjection();

        const segment = this.uiSegmentSrv.newSegment('none');
        this.metricColumnSegment.html = segment.html;
        this.metricColumnSegment.value = segment.value;
        this.target.metricColumn = 'none';

        const task1 = this.getTimeColumnSegments().then(result => {
            // check if time column is still valid
            if (result.length > 0 && !_.find(result, (r: any) => r.text === this.target.timeColumn)) {
                const segment = this.uiSegmentSrv.newSegment(result[0].text);
                this.timeColumnSegment.html = segment.html;
                this.timeColumnSegment.value = segment.value;
            }
            return this.timeColumnChanged(false);
        });

        const task2 = this.getValueColumnSegments().then(result => {
            if (result.length > 0) {
                this.target.select = [[{type: 'column', params: [result[0].text]}]];
                this.updateProjection();
            }
        });
        this.$q.all([task1, task2]).then(() => {
            this.panelCtrl.refresh();
        });
    }

    getTimeColumnSegments() {
        return this._getColumnSegments(['DATE', 'TIMESTAMP', 'DATETIME']);
    }

    getValueColumnSegments() {
        return this._getColumnSegments(['INT64', 'NUMERIC', 'FLOAT64', 'FLOAT', 'INT', 'INTEGER']);
    }

    _getColumnSegments(filter) {
        return this.datasource.getTableFields(this.target.project, this.target.dataset, this.target.table,
            filter)
            .then(this.uiSegmentSrv.transformToSegments(false))
            .catch(this.handleQueryError.bind(this));
    }

    async _getDateFieldType() {
        let res = '';
        await this.datasource.getTableFields(this.target.project, this.target.dataset, this.target.table,
            ['DATE', 'TIMESTAMP', 'DATETIME']).then(result => {
            for (let f of result) {
                if (f.text === this.target.timeColumn) {
                    res = f.value;
                }
            }
        });
        return res;
    }

    async timeColumnChanged(refresh?: boolean) {
        this.target.timeColumn = this.timeColumnSegment.value;
        this.target.timeColumnType = await this._getDateFieldType();
        let partModel;
        partModel = sqlPart.create({type: 'macro', name: '$__timeFilter', params: []});
        this.setwWereParts(partModel);
        this.updatePersistedParts();
        if (refresh !== false) {
            this.panelCtrl.refresh();
        }
    }
    getMetricColumnSegments() {
        return this.datasource.getTableFields(this.target.project, this.target.dataset, this.target.table, ['STRING', 'BYTES'])
            .then(this.uiSegmentSrv.transformToSegments(false))
            .catch(this.handleQueryError.bind(this));
    }

    metricColumnChanged() {
        this.target.metricColumn = this.metricColumnSegment.value;
        this.panelCtrl.refresh();
    }

    onDataReceived(dataList) {
        return;
    }

    onDataError(err) {
        if (err.data && err.data.results) {
            const queryRes = err.data.results[this.target.refId];
            if (queryRes) {
                this.lastQueryMeta = queryRes.meta;
                this.lastQueryError = queryRes.error;
            }
        }
    }

    transformToSegments(config) {
        return results => {
            const segments = _.map(results, segment => {
                return this.uiSegmentSrv.newSegment({
                    value: segment.text,
                    expandable: segment.expandable,
                });
            });
            if (config.addTemplateVars) {
                for (const variable of this.templateSrv.variables) {
                    let value;
                    value = '$' + variable.name;
                    if (config.templateQuoter && variable.multi === false) {
                        value = config.templateQuoter(value);
                    }
                    segments.unshift(
                        this.uiSegmentSrv.newSegment({
                            type: 'template',
                            value: value,
                            expandable: true,
                        })
                    );
                }
            }

            if (config.addNone) {
                segments.unshift(this.uiSegmentSrv.newSegment({type: 'template', value: 'none', expandable: true}));
            }
            return segments;
        };
    }

    findAggregateIndex(selectParts) {
        return _.findIndex(selectParts, (p: any) => p.def.type === 'aggregate' || p.def.type === 'percentile');
    }

    findWindowIndex(selectParts) {
        return _.findIndex(selectParts, (p: any) => p.def.type === 'window' || p.def.type === 'moving_window');
    }

    applySegment(dst, src) {
        dst.value = src.value;
        dst.html = src.html || src.value;
        dst.fake = src.fake === undefined ? false : src.fake;
    }

    fakeSegment(value) {
        return this.uiSegmentSrv.newSegment({fake: true, value: value});
    }

    addSelectPart(selectParts, item, subItem) {
        let partType = item.value;
        if (subItem && subItem.type) {
            partType = subItem.type;
        }
        let partModel = sqlPart.create({type: partType});
        if (subItem) {
            partModel.params[0] = subItem.value;
        }
        let addAlias = false;
        let _addAlias = function () {
            return !_.find(selectParts, (p: any) => p.def.type === 'alias');
        };
        switch (partType) {
            case 'column':
                const parts = _.map(selectParts, (part: any) => {
                    return sqlPart.create({type: part.def.type, params: _.clone(part.params)});
                });
                this.selectParts.push(parts);
                break;
            case 'percentile':
            case 'aggregate':
                // add group by if no group by yet
                if (this.target.group.length === 0) {
                    this.addGroup('time', '$__interval');
                }
                const aggIndex = this.findAggregateIndex(selectParts);
                if (aggIndex !== -1) {
                    // replace current aggregation
                    selectParts[aggIndex] = partModel;
                } else {
                    selectParts.splice(1, 0, partModel);
                }
                if (_addAlias()) {
                    addAlias = true;
                }
                break;
            case 'moving_window':
            case 'window':
                const windowIndex = this.findWindowIndex(selectParts);
                if (windowIndex !== -1) {
                    // replace current window function
                    selectParts[windowIndex] = partModel;
                } else {
                    const aggIndex = this.findAggregateIndex(selectParts);
                    if (aggIndex !== -1) {
                        selectParts.splice(aggIndex + 1, 0, partModel);
                    } else {
                        selectParts.splice(1, 0, partModel);
                    }
                }
                if (_addAlias()) {
                    addAlias = true;
                }
                break;
            case 'alias':
                addAlias = true;
                break;
        }

        if (addAlias) {
            // set initial alias name to column name
            partModel = sqlPart.create({type: 'alias', params: [selectParts[0].params[0].replace(/"/g, '')]});
            if (selectParts[selectParts.length - 1].def.type === 'alias') {
                selectParts[selectParts.length - 1] = partModel;
            } else {
                selectParts.push(partModel);
            }
        }

        this.updatePersistedParts();
        this.panelCtrl.refresh();
    }

    removeSelectPart(selectParts, part) {
        if (part.def.type === 'column') {
            // remove all parts of column unless its last column
            if (this.selectParts.length > 1) {
                const modelsIndex = _.indexOf(this.selectParts, selectParts);
                this.selectParts.splice(modelsIndex, 1);
            }
        } else {
            const partIndex = _.indexOf(selectParts, part);
            selectParts.splice(partIndex, 1);
        }

        this.updatePersistedParts();
    }


    handleSelectPartEvent(selectParts, part, evt) {
        switch (evt.name) {
            case 'get-param-options': {
                switch (part.def.type) {
                    case 'aggregate':
                        return;
                    case 'column':
                        return this.getValueColumnSegments();
                }
            }
            case 'part-param-changed': {
                this.updatePersistedParts();
                this.panelCtrl.refresh();
                break;
            }
            case 'action': {
                this.removeSelectPart(selectParts, part);
                this.panelCtrl.refresh();
                break;
            }
            case 'get-part-actions': {
                return this.$q.when([{text: 'Remove', value: 'remove-part'}]);
            }
        }
    }

    handleGroupPartEvent(part, index, evt) {
        switch (evt.name) {
            case 'get-param-options': {
                return this.datasource.getTableFields(this.target.project, this.target.dataset, this.target.table, [])
                    .then(this.transformToSegments({}))
                    .catch(this.handleQueryError.bind(this));
            }
            case 'part-param-changed': {
                this.updatePersistedParts();
                this.panelCtrl.refresh();
                break;
            }
            case 'action': {
                this.removeGroup(part, index);
                this.panelCtrl.refresh();
                break;
            }
            case 'get-part-actions': {
                return this.$q.when([{text: 'Remove', value: 'remove-part'}]);
            }
        }
    }

    _setgroupParts(partType, value) {
        let params = [value];
        if (partType === 'time') {
            params = ['$__interval', 'none'];
        }
        const partModel = sqlPart.create({type: partType, params: params});

        if (partType === 'time') {
            // put timeGroup at start
            this.groupParts.splice(0, 0, partModel);
        } else {
            this.groupParts.push(partModel);
        }
    }

    addGroup(partType, value) {
        this._setgroupParts(partType, value);
        // add aggregates when adding group by
        for (const selectParts of this.selectParts) {
            if (!selectParts.some(part => part.def.type === 'aggregate')) {
                const aggregate = sqlPart.create({type: 'aggregate', params: ['avg']});
                selectParts.splice(1, 0, aggregate);
                if (!selectParts.some(part => part.def.type === 'alias')) {
                    const alias = sqlPart.create({type: 'alias', params: [selectParts[0].part.params[0]]});
                    selectParts.push(alias);
                }
            }
        }

        this.updatePersistedParts();
    }

    removeGroup(part, index) {
        if (part.def.type === 'time') {
            // remove aggregations
            this.selectParts = _.map(this.selectParts, (s: any) => {
                return _.filter(s, (part: any) => {
                    if (part.def.type === 'aggregate' || part.def.type === 'percentile') {
                        return false;
                    }
                    return true;
                });
            });
        }

        this.groupParts.splice(index, 1);
        this.updatePersistedParts();
    }

    handleWherePartEvent(whereParts, part, evt, index) {
        switch (evt.name) {
            case 'get-param-options': {
                switch (evt.param.name) {
                    case 'left':
                        return this.datasource.getTableFields(this.target.project, this.target.dataset, this.target.table,
                            [])
                            .then(this.transformToSegments({}))
                            .catch(this.handleQueryError.bind(this));
                    case 'right':
                        return this.$q.when([]);
                    case 'op':
                        return this.$q.when(this.uiSegmentSrv.newOperators(['=', '!=', '<', '<=', '>', '>=']));
                    default:
                        return this.$q.when([]);
                }
            }
            case 'part-param-changed': {
                this.updatePersistedParts();
                this.panelCtrl.refresh();
                break;
            }
            case 'action': {
                // remove element
                whereParts.splice(index, 1);
                this.updatePersistedParts();
                this.panelCtrl.refresh();
                break;
            }
            case 'get-part-actions': {
                return this.$q.when([{text: 'Remove', value: 'remove-part'}]);
            }
        }
    }

    getWhereOptions() {
        const options = [];
        options.push(this.uiSegmentSrv.newSegment({type: 'macro', value: '$__timeFilter'}));
        options.push(this.uiSegmentSrv.newSegment({type: 'expression', value: 'Expression'}));
        return this.$q.when(options);
    }

    setwWereParts(partModel) {
        if (this.whereParts.length >= 1 && this.whereParts[0].def.type === 'macro') {
            // replace current macro
            this.whereParts[0] = partModel;
        } else {
            this.whereParts.splice(0, 0, partModel);
        }
    }

    addWhereAction(part, index) {
        switch (this.whereAdd.type) {
            case 'macro': {
                const partModel = sqlPart.create({type: 'macro', name: this.whereAdd.value, params: []});
                this.setwWereParts(partModel);
                break;
            }
            default: {
                this.whereParts.push(sqlPart.create({type: 'expression', params: ['value', '=', 'value']}));
            }
        }

        this.updatePersistedParts();
        this.resetPlusButton(this.whereAdd);
        this.panelCtrl.refresh();
    }

    getGroupOptions() {
        return this.getMetricColumnSegments()
            .then(tags => {
                const options = [];
                if (!this.queryModel.hasTimeGroup()) {
                    options.push(this.uiSegmentSrv.newSegment({type: 'time', value: 'time($__interval,none)'}));
                }
                for (const tag of tags) {
                    options.push(this.uiSegmentSrv.newSegment({type: 'column', value: tag.text}));
                }
                return options;
            })
            .catch(this.handleQueryError.bind(this));
    }

    addGroupAction() {
        switch (this.groupAdd.value) {
            default: {
                this.addGroup(this.groupAdd.type, this.groupAdd.value);
            }
        }

        this.resetPlusButton(this.groupAdd);
        this.panelCtrl.refresh();
    }

    handleQueryError(err) {
        this.error = err.message || 'Failed to issue metric query';
        return [];
    }
}
