import _ from 'lodash';


export default class BigQueryQuery {
    target: any;
    templateSrv: any;
    scopedVars: any;
    isWindow: boolean;
    groupBy: string;
    tmpcost: string;

    /** @ngInject */
    constructor(target, templateSrv?, scopedVars?) {
        this.target = target;
        this.templateSrv = templateSrv;
        this.scopedVars = scopedVars;
        this.isWindow = false;
        this.groupBy = '';
        this.tmpcost = '';

        target.format = target.format || 'time_series';
        target.timeColumn = target.timeColumn || '-- time --';
        target.metricColumn = target.metricColumn || 'none';

        target.group = target.group || [];
        target.where = target.where || [{type: 'macro', name: '$__timeFilter', params: []}];
        target.select = target.select || [[{type: 'column', params: ['-- value --']}]];

        // handle pre query gui panels gracefully
        if (!('rawQuery' in this.target)) {
            target.rawQuery = 'rawSql' in target;
        }

        // give interpolateQueryStr access to this
        this.interpolateQueryStr = this.interpolateQueryStr.bind(this);
    }

    quoteLiteral(value) {
        return "'" + String(value).replace(/'/g, "''") + "'";
    }

    escapeLiteral(value) {
        return String(value).replace(/'/g, "''");
    }

    hasTimeGroup() {
        return _.find(this.target.group, (g: any) => g.type === 'time');
    }

    hasMetricColumn() {
        return this.target.metricColumn !== 'none';
    }

    interpolateQueryStr(value, variable, defaultFormatFn) {
        // if no multi or include all do not regexEscape
        if (!variable.multi && !variable.includeAll) {
            return this.escapeLiteral(value);
        }

        if (typeof value === 'string') {
            return this.quoteLiteral(value);
        }

        const escapedValues = _.map(value, this.quoteLiteral);
        return escapedValues.join(',');
    }

    render(interpolate?) {
        const target = this.target;

        // new query with no table set yet
        if (!this.target.rawQuery && !('table' in this.target)) {
            return '';
        }

        if (!target.rawQuery) {
            target.rawSql = this.buildQuery();
        }
        if (interpolate) {
            return this.templateSrv.replace(target.rawSql, this.scopedVars, this.interpolateQueryStr);
        } else {
            return target.rawSql;
        }
    }

    buildTimeColumn(alias = true) {
        const timeGroup = this.hasTimeGroup();
        let query;
        let macro = '$__timeGroup';

        if (timeGroup) {
            let args;
            if (timeGroup.params.length > 1 && timeGroup.params[1] !== 'none') {
                args = timeGroup.params.join(',');
            } else {
                args = timeGroup.params[0];
            }
            if (alias) {
                macro += 'Alias';
            }
            query = macro + '(' + this.target.timeColumn + ',' + args + ')';
        } else {
            query = this.target.timeColumn;
            if (alias) {
                query += ' AS time';
            }
        }

        return query;
    }

    buildMetricColumn() {
        if (this.hasMetricColumn()) {
            return this.target.metricColumn + ' AS metric';
        }

        return '';
    }

    buildValueColumns() {
        let query = '';
        for (const column of this.target.select) {
            query += ',\n  ' + this.buildValueColumn(column);
        }

        return query;
    }

    buildValueColumn(column) {
        let query = '';

        const columnName = _.find(column, (g: any) => g.type === 'column');
        query = columnName.params[0];

        const aggregate = _.find(column, (g: any) => g.type === 'aggregate' || g.type === 'percentile');
        const windows = _.find(column, (g: any) => g.type === 'window' || g.type === 'moving_window');
        if (aggregate) {
            const func = aggregate.params[0];
            switch (aggregate.type) {
                case 'aggregate':
                    if (func === 'first' || func === 'last') {
                        query = func + '(' + query + ',' + this.target.timeColumn + ')';
                    } else {
                        query = func + '(' + query + ')';
                    }
                    break;
                case 'percentile':
                    query = func + '(' + aggregate.params[1] + ') WITHIN GROUP (ORDER BY ' + query + ')';
                    break;
            }
        }

        if (windows) {
            this.isWindow = true;
            const overParts = [];
            if (this.hasMetricColumn()) {
                overParts.push('PARTITION BY ' + this.target.metricColumn);
            }
            overParts.push('ORDER BY ' + this.buildTimeColumn(false));

            const over = overParts.join(' ');
            let curr: string;
            let prev: string;
            let tmpval = query;
            switch (windows.type) {
                case 'window':
                    switch (windows.params[0]) {
                        case 'delta':
                            curr = query;
                            prev = 'lag(' + curr + ') OVER (' + over + ')';
                            query = curr + ' - ' + prev;
                            break;
                        case 'increase':
                            curr = query;
                            prev = 'lag(' + curr + ') OVER (' + over + ')';
                            query = '(CASE WHEN ' + curr + ' >= ' + prev + ' THEN ' + curr + ' - ' + prev;
                            query += ' WHEN ' + prev + ' IS NULL THEN NULL ELSE ' + curr + ' END)';
                            break;
                        case 'rate':
                            let timeColumn = this.target.timeColumn;
                            if (aggregate) {
                                timeColumn = 'min(' + timeColumn + ')';
                            }

                            curr = query;
                            prev = 'lag(' + curr + ') OVER (' + over + ')';
                            query = '(CASE WHEN ' + curr + ' >= ' + prev + ' THEN ' + curr + ' - ' + prev;
                            query += ' WHEN ' + prev + ' IS NULL THEN NULL ELSE ' + curr + ' END)';
                            query += '/(UNIX_SECONDS(' + timeColumn + ') -UNIX_SECONDS(  lag(' + timeColumn + ') OVER (' + over + ')))';
                            break;
                        default:
                            query = windows.params[0] + '(' + query + ') OVER (' + over + ')';
                            break;
                    }
                    break;
                case 'moving_window':
                    query = windows.params[0] + '(' + query + ') OVER (' + over + ' ROWS ' + windows.params[1] + ' PRECEDING)';
                    query= tmpval + " as tmp" + tmpval +", " +query;
                    break;
            }
            this.tmpcost = "tmp" + columnName.params[0];
            query = tmpval + " as " + this.tmpcost + ", " + query;
        }

        const alias = _.find(column, (g: any) => g.type === 'alias');
        if (alias) {
            query += ' AS ' + alias.params[0];
        }
        return query;
    }

    buildWhereClause() {
        let query = '';
        const conditions = _.map(this.target.where, (tag, index) => {
            switch (tag.type) {
                case 'macro':
                    return tag.name + '(' + this.target.timeColumn + ')';
                    break;
                case 'expression':
                    return tag.params.join(' ');
                    break;
            }
        });
        if (conditions.length > 0) {
            query = '\nWHERE\n  ' + conditions.join(' AND\n  ');
        }
        return query;
    }

    buildGroupClause() {
        let query = '';
        let groupSection = '';
        for (let i = 0; i < this.target.group.length; i++) {
            const part = this.target.group[i];
            if (i > 0) {
                groupSection += ', ';
            }
            if (part.type === 'time') {
                groupSection += '1';
            } else {
                groupSection += part.params[0];
            }
        }
        if (groupSection.length ) {
            query = '\nGROUP BY ' + groupSection;
            this.groupBy = query;
            if (this.isWindow) {
                query += "," +this.target.timeColumn;
                this.groupBy += ',2';
            }
            if (this.hasMetricColumn()) {
                if (!this.isWindow) {
                    query += ',2';
                } else {
                    query += ',2';
                    this.groupBy += ',3';
                }
            }
        }
        return query;
    }

    buildQuery() {
        let query = '';
        query += '\n' + 'SELECT';
        query += '\n ' + this.buildTimeColumn();
        if (this.hasMetricColumn()) {
            query += ',\n  ' + this.buildMetricColumn();
        }
        query += this.buildValueColumns();

        query += '\nFROM ' + this.target.dataset + "." + this.target.table ;

        query += this.buildWhereClause();
        query += this.buildGroupClause();

        query += '\nORDER BY 1';
        if (this.hasMetricColumn()) {
            query += ',2';
        }
      //query += '\nLIMIT 15';
        if (this.isWindow ){
            query = "select *  EXCEPT (" + this.tmpcost + ") From \n (" + query;
            query = query + ")" + this.groupBy + " order by 1";
        }
        query = '#standardSQL' + query;
        return query;
    }

    expend_macros(options) {
        if (this.target.rawSql) {
            let q = this.target.rawSql;
            q = this.replaceTimeFilters(q,options);
            q = this.replacetimeGroupAlias(q,true);
            q = this.replacetimeGroupAlias(q,false);
            console .log(q);
            return q;
        }
    }

    replaceTimeFilters(q,options) {
            const from = "TIMESTAMP_MILLIS (" + options.range.from.valueOf().toString() + ")";
            const to = "TIMESTAMP_MILLIS (" + options.range.to.valueOf().toString() + ")";
            const range = this.target.timeColumn + ' BETWEEN ' + from + ' AND ' + to;
            return q.replace(/\$__timeFilter\(([\w_]+)\)/g, range);
    }
    replacetimeGroupAlias(q,alias) {
        let interval = '';
        if (alias) {
             interval = q.match(/(?<=.*\$__timeGroupAlias\(([\w_]+,)).*?(?=\))/g);
        } else {
             interval = q.match(/(?<=.*\$__timeGroup\(([\w_]+,)).*?(?=\))/g);
        }
        if  (!interval) {
            return q;
        }
        let intervalStr = "TIMESTAMP_SECONDS(DIV(UNIX_SECONDS("+ this.target.timeColumn + "), ";
        switch (interval[0]) {
            case '1s': {
                intervalStr += "1) * 1)";
                break;
            }
            case '1m': {
                intervalStr += "60) * 60)";
                break;
            }
            case '1h': {
                intervalStr += "3600) * 3600)";
                break;
            }
            case '1d': {
                intervalStr += "86400) * 86400)";
                break;
            }
        }
        if (alias) {
            return q.replace(/\$__timeGroupAlias\(([\w_]+,+[\w_]+\))/g, intervalStr);
        } else {
            return q.replace(/\$__timeGroup\(([\w_]+,+[\w_]+\))/g,intervalStr);
        }
    }
}
