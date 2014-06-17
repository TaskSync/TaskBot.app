var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
///<reference path="../node_modules/asyncmachine/lib/asyncmachine.d.ts"/>
///<reference path="../node_modules/compiled-coffee/node_modules/typescript-yield/d.ts/suspend.d.ts" />
///<reference path="../d.ts/global.d.ts" />
var suspend = require('suspend');
var gmail = require('./gmail');
var settings = require('../settings');
exports.go = suspend.resume;
exports.async = suspend.async;

var App = (function (_super) {
    __extends(App, _super);
    function App() {
        _super.apply(this, arguments);
    }
    App.prototype.Connected_enter = function (states) {
        this.addQuery("*", 1000);
        if (!this.add("Active")) {
            this.log("cant activate Active (states: " + (this.is()) + ")");
        }
        return true;
    };
    return App;
})(gmail.Connection);
exports.App = App;

suspend.fn(function* () {
    var client = new App(settings);
    yield setTimeout(exports.go(), 10 * 1000);
    return client.add("Disconnected", true);
})();
//# sourceMappingURL=app.js.map