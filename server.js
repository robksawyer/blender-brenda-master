// server.js
// config
global.dirname = __dirname;
global.config = require('./config/serverconfig');
// requires
var express         = require('express'),
    passport        = require('passport'),
    basicStrategy   = require('passport-http').BasicStrategy,
    spawn           = require('child_process').spawn,
    busboy          = require('connect-busboy'),
    fs              = require('fs'),
    express_session = require('express-session'),
    SQLiteStore     = require('connect-sqlite3')(express_session),
    cookieParser    = require('cookie-parser'),
    BrendaProjects  = require('./server/brenda-projects')(fs),
    app             = express(),                       
    server          = app.listen(global.config.port),
    io              = require('socket.io').listen(server),
    procs           = require('./server/processes')(spawn, io),
    serveIndex      = require('serve-index'),
    serveStatic     = require('serve-static'),
    influx          = require('influx');


// file handler
app.use(busboy());
// set up authentication and then static files

var sessionStore = new SQLiteStore({'dir': __dirname + '/server'});
var cParser = new cookieParser(global.config.session_secret);
var session = express_session({
    key: global.config.session_key,
    store: sessionStore,
    secret: global.config.session_secret,
    resave: true,
    saveUninitialized: true
  });
require('./server/auth')(app, global.config, passport, basicStrategy, cParser, session);
app.use(express.static(__dirname + '/grafana/dist')); 

app.use('/projects', serveIndex(global.config.projects_dir, {'icons': true}));
app.use('/projects', serveStatic(global.config.projects_dir));

if (global.config.influxdb && !global.config.influxdb.readonly) {
  // InfluxDB connection
  var dbname = global.config.influxdb.database || 'brenda';
  var influxclient = influx({
    host : global.config.influxdb.host || 'localhost',
    port : global.config.influxdb.port || 8086, // optional, default 8086
    username : global.config.influxdb.user || 'root',
    password : global.config.influxdb.password || 'root',
    database : dbname
  });
  procs.setDatabase(influxclient);
  influxclient.getDatabaseNames(function(err, dbnames) {
    // Create databases if they don't exist
    if (dbnames.indexOf('grafana') == -1) influxclient.createDatabase('grafana');
    if (dbnames.indexOf(dbname) == -1) influxclient.createDatabase(dbname);
  });
}

// make sure children die
process.on('exit', function() {
  procs.killAll();
});

// Start polling for instance and job information
procs.checkInstanceCounts();
procs.checkJobCount();

// socket setup

io.use(function(socket, next) {
  // get the session info from the request and assign it to the socket
  session(socket.request, {}, next);
}).use(function(socket, next) {
  // checks if the socket has a valid session and user, and accepts or denies the
  // connection accordingly
  var ip_address = socket.request.headers['x-forwarded-for'];
  if (socket.request.session && socket.request.session.passport && socket.request.session.passport.user) {
    console.log('Accepting socket connection from user:', socket.request.session.passport.user.username, ip_address);
    return next();
  }
  console.log('Denying socket connection from unauthorized user at', ip_address);
  return next(new Error("Unauthorized user"), false);
});

// event listeners

io.on('connection', function(client) { 
  client.emit('connected', client.id);        
  console.log('client', client.id, 'connected');
  client.emit('projectupdate', BrendaProjects.projects);
  procs.getRegionConfigs(function(files) {
    var regions = [];
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].split('/');
      regions.push(parts[parts.length - 1]);
    }
    client.emit('regionconfigs', regions);
  });
  client.on('submitjob', function(data) {
    console.log('job submit, data: ', data);
    procs.submitJob(client, data);
  });
  client.on('spawninstance', function(data) {
    console.log('instance submit, data: ', data);
    procs.spawnInstance(client, data);
  });
  client.on('checkprice', function(data) {
    console.log('price check', data.instancetype);
    procs.checkInstancePrice(client, data);
  });
  client.on('addProject', function(data) {
    console.log('adding new project: ', data);
    BrendaProjects.addProject(data, function(name) {
      console.log('added project:', name);
      client.emit('projectadded', name);
      client.emit('projectupdate', BrendaProjects.projects);
    });
  });
  client.on('getBlenderFiles', function(data) {
    console.log('getting blender files for project', data);
    procs.getBlenderFiles(data, function(files) {
      client.emit('blenderFileUpdate', files);
    });
  });
});


// api routes

app.post('/api/upload:client_id', function(req, res) {
  var client_id = req.params.client_id;
  req.pipe(req.busboy);
  req.busboy.on('file', function(fieldname, file, filename) {
    console.log(global.config.jobdata_dir + filename);
    var fstream = fs.createWriteStream(global.config.jobdata_dir + filename); 
    file.pipe(fstream);
    fstream.on('close', function () {
        // file upload completed (hopefully)
        procs.buildJobFile(client_id, filename);
        res.redirect('back');
    });
  });
});

console.log("server listening on", global.config.port);
