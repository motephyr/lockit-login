'use strict';

var path = require('path');
var events = require('events');
var util = require('util');
var express = require('express');
var ms = require('ms');
var moment = require('moment');
var utils = require('lockit-utils');
var pwd = require('couch-pwd');
var uuid = require('node-uuid');
var jsend = require('express-jsend');

/**
 * Internal helper functions
 */

function join(view) {
  return path.join(__dirname, 'views', view);
}



/**
 * Login constructor function.
 *
 * @constructor
 * @param {Object} config
 * @param {Object} adapter
 */
var Login = module.exports = function(config, adapter) {

  if (!(this instanceof Login)) {return new Login(config, adapter); }

  // call super constructor function
  events.EventEmitter.call(this);

  this.config = config;
  this.adapter = adapter;

  // set default routes
  this.loginRoute = config.login.route || '/login';
  var logoutRoute = config.login.logoutRoute || '/logout';

  // change URLs if REST is active
  if (config.rest) {
    this.loginRoute = '/rest' + this.loginRoute;
    logoutRoute = '/rest' + logoutRoute;
  }

  // two-factor authentication route
  this.twoFactorRoute = this.loginRoute + (config.login.twoFactorRoute || '/two-factor');

  var router = new express.Router();
  router.get(this.loginRoute, this.getLogin.bind(this));
  router.post(this.loginRoute, this.postLogin.bind(this));
  router.post(this.twoFactorRoute, this.postTwoFactor.bind(this));
  router.post(logoutRoute, utils.authenticatedOnly(config), this.postLogout.bind(this));
  this.router = router;

};

util.inherits(Login, events.EventEmitter);



/**
 * GET /login route handling function.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Login.prototype.getLogin = function(req, res, next) {

  var config = this.config;
  var that = this;

  // do not handle the route when REST is active
  if (config.rest) {return next(); }

  // save redirect url
  var suffix = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';

  // custom or built-in view
  var view = config.login.views.login || join('get-login');

  // render view
  res.render(view, {
    title: 'Login',
    action: that.loginRoute + suffix,
    basedir: req.app.get('views')
  });
};



/**
 * POST /login route handling function.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Login.prototype.postLogin = function(req, res, next) {

  var adapter = this.adapter;
  var config = this.config;
  var that = this;

  var error = '';

  var login = req.body.login;
  var password = req.body.password;

  // save redirect url
  var suffix = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';

  // custom or built-in view
  var view = config.login.views.login || join('get-login');

  // check for valid inputs
  if (!login || !password) {
    error = 'Please enter your email/username and password';

    // send only JSON when REST is active
    if (config.rest) {return res.json(403, {error: error}); }

    // render view
    res.status(403);
    res.render(view, {
      title: 'Login',
      action: that.loginRoute + suffix,
      error: error,
      login: login,
      basedir: req.app.get('views')
    });
    return;
  }

  // check if login is a name or an email address

  // regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
  var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;
  var query = EMAIL_REGEXP.test(login) ? 'email' : 'name';

  // find user in db
  adapter.find(query, login, function(err, user) {
    if (err) {return next(err); }

    // no user or user email isn't verified yet -> render error message
    if (!user) {
      error = 'Invalid user or password';

      // render view
      return res.format({
        json: function() {
          return res.status(403).jerror(new Error(error));
        },
        html: function() {
          res.status(403)
          return res.render(view, {
            title: 'Login',
            action: that.loginRoute + suffix,
            error: error,
            login: login,
            basedir: req.app.get('views')
          });
        }
      });  
    }

    // user is not verified
    if (!user.emailVerified) {
      error = 'Your account has not been verified';

      // render view
      return res.format({
        json: function() {
          return res.status(403).jsend(new Error(error));
        },
        html: function() {
          res.status(403)
          res.render(view, {
            title: 'Login',
            action: that.loginRoute + suffix,
            error: error,
            login: login,
            basedir: req.app.get('views')
          });
          return;
        }
      });      
    }

    // check for too many failed login attempts
    if (user.accountLocked && new Date(user.accountLockedUntil) > new Date()) {
      error = 'The account is temporarily locked';

      // send only JSON when REST is active
      if (config.rest) {return res.status(403).jsend(new Error(error)); }

      // render view
      res.status(403);
      res.render(view, {
        title: 'Login',
        action: that.loginRoute + suffix,
        error: error,
        login: login,
        basedir: req.app.get('views')
      });
      return;
    }

    // if user comes from couchdb it has an 'iterations' key
    if (user.iterations) {pwd.iterations(user.iterations); }

    // compare credentials with data in db
    pwd.hash(password, user.salt, function(hashErr, hash) {
      if (hashErr) {return next(hashErr); }

      if (hash !== user.derived_key) {
        // set the default error message
        var errorMessage = 'Invalid user or password';

        // increase failed login attempts
        user.failedLoginAttempts += 1;

        // lock account on too many login attempts (defaults to 5)
        if (user.failedLoginAttempts >= config.failedLoginAttempts) {
          user.accountLocked = true;

          // set locked time to 20 minutes (default value)
          var timespan = ms(config.accountLockedTime);
          user.accountLockedUntil = moment().add(timespan, 'ms').toDate();

          errorMessage = 'Invalid user or password. Your account is now locked for ' + config.accountLockedTime;
        } else if (user.failedLoginAttempts >= config.failedLoginsWarning) {
          // show a warning after 3 (default setting) failed login attempts
          errorMessage = 'Invalid user or password. Your account will be locked soon.';
        }

        // save user to db
        adapter.update(user, function(updateErr) {
          if (updateErr) {return next(updateErr); }

          // send only JSON when REST is active
          if (config.rest) {return res.json(403, {error: errorMessage}); }

          // send error message
          res.status(403);
          res.render(view, {
            title: 'Login',
            action: that.loginRoute + suffix,
            error: errorMessage,
            login: login,
            basedir: req.app.get('views')
          });
        });

        return;

      }

      // looks like password is correct

      // shift tracking values
      var now = new Date();

      // update previous login time and ip
      user.previousLoginTime = user.currentLoginTime || now;
      user.previousLoginIp = user.currentLoginIp || req.ip;

      // save login time
      user.currentLoginTime = now;
      user.currentLoginIp = req.ip;

      // set failed login attempts to zero but save them in the session
      user.failedLoginAttempts = 0;
      user.accountLocked = false;

      // create and set an authentication token
      if (!user.authenticationToken) {
        var authenticationToken = uuid.v4();
        user.authenticationToken = authenticationToken;
      }

      // save user to db
      adapter.update(user, function(updateErr, updatedUser) {
        if (updateErr) {return next(updateErr); }

        // check if two-factor authentication is enabled
        if (!updatedUser.twoFactorEnabled) {

          // get redirect url
          var target = req.query.redirect || '/';

          // emit 'login' event
          that.emit('login', updatedUser, res, target);

          // render view
          return res.format({
            json: function() {
              // prepare the user object for return
              var userObject = {
                "id": updatedUser._id,
                "email": updatedUser.email,
                "authenticationToken": updatedUser.authenticationToken
              };
              // add user columns
              if (config.userColumns) {
                for (var column in config.userColumns) {
                  userObject[column] = updatedUser[column];
                }
              }

              return res.jsend(userObject);
            },
            html: function() {
              // user is now logged in
              req.session.loggedIn = true;

              // create session and save the name and email address
              req.session.name = updatedUser.name;
              req.session.email = updatedUser.email;

              req.session.failedLoginAttempts = user.failedLoginAttempts;
              return res.redirect(target);
            }
          }); 
        }
        else {

          // two-factor authentication is enabled

          // render view
          return res.format({
            json: function() {
              res.jsend({
                "twoFactorEnabled": true
              });

              return;
            },
            html: function() {
              // custom or built-in view
              var twoFactorView = config.login.views.twoFactor || join('two-factor');

              // render two-factor authentication template
              res.render(twoFactorView, {
                title: 'Two-factor authentication',
                action: that.twoFactorRoute,
                basedir: req.app.get('views')
              });

              return;
            }
          }); 
        }
      });
    });
  });
};



/**
 * POST /login/two-factor.
 *
 * Verify provided token using time-based one-time password.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Login.prototype.postTwoFactor = function(req, res, next) {

  var config = this.config;
  var adapter = this.adapter;
  var loginRoute = this.loginRoute;
  var that = this;

  var token = req.body.token || '';
  var email = req.session.email || '';

  // get redirect url
  var target = req.query.redirect || '/';

  // get user from db
  adapter.find('email', email, function(err, user) {
    if (err) {return next(err); }

    var key = user && user.twoFactorKey;

    // verify POSTed token
    var valid = utils.verify(token, key);

    // redirect to /login if invalid
    if (!valid) {
      // destroy current session
      return utils.destroy(req, function() {
        // send only JSON when REST is active
        if (config.rest) {return res.send(401); }
        res.redirect(loginRoute + '?redirect=' + target);
      });
    }

    // token seems to be fine

    // user is now logged in
    req.session.loggedIn = true;

    // emit 'login' event
    that.emit('login', user, res, target);

    // let lockit handle the response
    if (config.login.handleResponse) {
      // send only JSON when REST is active
      if (config.rest) {return res.send(204); }

      // redirect to target url
      res.redirect(target);
    }

  });

};



/**
 * POST /logout route handling function.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Login.prototype.postLogout = function(req, res) {
  var config = this.config;
  var adapter = this.adapter;
  var that = this;

  var respondLogout = function(err, data, req, res) {
    // render view
    res.format({
      "json": function() {
        if (err) {
          res.jerror(err);
        }
        else {
          res.jsend("Logout successful");
        }

        return;
      },
      "html": function() {
        // TODO handle HTML error

        // custom or built-in view
        var view = config.login.views.loggedOut || join('get-logout');

        // reder logout success template
        res.render(view, {
          title: 'Logout successful',
          basedir: req.app.get('views')
        });

        return;
      }
    }); 
  }

  var token = utils.token(req);
  if (token) {
    // logout by token
    adapter.find('authenticationToken', token, function(err, user) {  
      if (err) {
        respondLogout('Unable to find user with token', null, req, res);
      }
      else {
        // clear the token
        user.authenticationToken = null;
        
        // save updated user to db
        adapter.update(user, function(err, user) {
          if (err) {
            respondLogout('Unable to save user with cleared token', null, req, res);
          }
          else {
            respondLogout(null, 'Logout successful', req, res);
          }
        });
      }
    });
  }
  else {
    // logout from the session

    // save values for event emitter
    var user = {
      name: req.session.name,
      email: req.session.email
    };

    // destroy the session
    utils.destroy(req, function() {
      // clear local variables - they were set before the session was destroyed
      res.locals.name = null;
      res.locals.email = null;

      // emit 'logout' event
      that.emit('logout', user, res);

      // let lockit handle the response
      if (config.login.handleResponse) {
        respondLogout(null, 'Logout successful', req, res);
      }
    });
  }

};
