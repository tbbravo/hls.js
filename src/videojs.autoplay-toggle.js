'use strict';

(function (window, document, videojs) {

  /**
   *  Cookie access functions.
   *  From: https://developer.mozilla.org/en-US/docs/Web/API/document.cookie
   */
  var cookies = {
    getItem: function (sKey) {
      if (!sKey) { return null; }
      return decodeURIComponent(
        document.cookie.replace(
          new RegExp("(?:(?:^|.*;)\\s*" + encodeURIComponent(sKey).replace(
            /[\-\.\+\*]/g, "\\$&") + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1")
        ) || null;
    },
    setItem: function (sKey, sValue, vEnd, sPath, sDomain, bSecure) {
      if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) { return false; }
      var sExpires = "";
      if (vEnd) {
        switch (vEnd.constructor) {
          case Number:
            sExpires = vEnd === Infinity ? "; expires=Fri, 31 Dec 9999 23:59:59 GMT" : "; max-age=" + vEnd;
            break;
          case String:
            sExpires = "; expires=" + vEnd;
            break;
          case Date:
            sExpires = "; expires=" + vEnd.toUTCString();
            break;
        }
      }
      document.cookie =
        encodeURIComponent(sKey) + "=" + encodeURIComponent(sValue)
          + sExpires
          + (sDomain ? "; domain=" + sDomain : "")
          + (sPath ? "; path=" + sPath : "")
          + (bSecure ? "; secure" : "");
      return true;
    },
    removeItem: function(sKey, sPath, sDomain) {
      if (!this.hasItem(sKey)) {
        return false;
      }
      document.cookie = encodeURIComponent(sKey) + "=;" + " expires=Thu, 01 Jan 1970 00:00:00 GMT" + (sDomain ? "; domain=" + sDomain : "") + (sPath ? "; path=" + sPath : "");
      return true;
    },
    hasItem: function (sKey) {
      if (!sKey) { return false; }
      return (new RegExp("(?:^|;\\s*)" + encodeURIComponent(sKey).replace(
        /[\-\.\+\*]/g, "\\$&") + "\\s*\\=")).test(document.cookie);
    },
  },

  /**
   *  Local storage functionality.
   */
  localStorage = {
    available: function() {
      try {
        window.localStorage.setItem('fishingForLocalStorage', 'itsHere');
        window.localStorage.removeItem('fishingForLocalStorage');
        return true;
      } catch(e) {
        return false;
      }
    },
    getItem: function(key) {
      return window.localStorage.getItem(key);
    },
    setItem: function(key, value) {
      return window.localStorage.setItem(key, value);
    },
    removeItem: function(key) {
      return window.localStorage.removeItem(key);
    }
  },

  /**
   *  Storage chooser, will use localstorage if available, otherwise use cookies.
   */
  storage = {
    getItem: function (key) {
      return localStorage.available() ? localStorage.getItem(key) : cookies.getItem(key);
    },
    setItem: function (key, value) {
      localStorage.available() ? localStorage.setItem(key, value) : cookies.setItem(key, value, Infinity, '/');
      return value;
    },
    removeItem: function (key) {
      localStorage.available() ? localStorage.removeItem(key) : cookies.removeItem(key);
    }
  },

  /**
   *  Object extend function.
   */
  extend = function(obj) {
    var arg, i, k;
    for (i = 1; i < arguments.length; i++) {
      arg = arguments[i];
      for (k in arg) {
        if (arg.hasOwnProperty(k)) {
          obj[k] = arg[k];
        }
      }
    }
    return obj;
  },

  /**
   *  Default settings for this plugin.
   */
  defaults = {
    namespace: 'autoplay-toggle',   // namespace for cookie/localstorage
  },

  /**
   *  Autoplay toggle plugin setup.
   */
  autoplayToggle = function (options) {

    var player = this,
        settings = extend({}, defaults, options || {}),
        key = settings.namespace + '-autoplay';

    // add new button to player
    var autoplayBtn = document.createElement('div');
    autoplayBtn.className = 'vjs-autoplay-toggle-button vjs-menu-button vjs-control';
    autoplayBtn.innerHTML =
      '<div>'
        + '<span class="vjs-control-text">'
            + '自动播放:<br>'
            + '<span class="autoplay-toggle autoplay-toggle-active autoplay-on">开</span>'
            + '&nbsp;/&nbsp;'
            + '<span class="autoplay-toggle autoplay-off">关</span>'
        + '</span>'
      + '</div>';
    player.controlBar.el().appendChild(autoplayBtn);

    // retrieve autoplay from storage and highlight the correct toggle option in *all* video players
    var autoplayToggleButton = function (activate) {

      // set cookie once
      activate ? storage.setItem(key, 'yes') : storage.setItem(key, 'no');

      // get all videos and toggle all their autoplays
      var videos = document.querySelectorAll('.video-js');
      for (var i = 0; i < videos.length; i++) {

        // check that this video has a toggle button
        var toggleBtnSelector  = videos[i].querySelectorAll('.vjs-autoplay-toggle-button');
        if (toggleBtnSelector.length > 0) {
          var toggleBtn = toggleBtnSelector[0],
              toggleOn = toggleBtn.querySelectorAll('.autoplay-on')[0],
              toggleOff = toggleBtn.querySelectorAll('.autoplay-off')[0];

          if (activate) {
            // toggle this on
            toggleOn.className = 'autoplay-toggle autoplay-toggle-active autoplay-on';
            toggleOff.className = 'autoplay-toggle autoplay-off';
          } else {
            // toggle this off
            toggleOn.className = 'autoplay-toggle autoplay-on';
            toggleOff.className = 'autoplay-toggle autoplay-toggle-active autoplay-off';
          }
        }
      }
    };

    var lock = storage.getItem(key);

    if (lock === 'yes') {
        turnOn = true;
    } else if (lock === 'no') {
        turnOn = false;
    } else if (lock === null) {
        turnOn = player.autoplay();
    }

    player.me || (player.me = {});

    // change player behavior based on toggle
    if (!turnOn) {
      // this could be autoplaying, make sure to stop it and ensure player's autoplay is false
      player.me.autoplay = false;

      player.autoplay(false);
      player.pause();
    } else if (turnOn) {
      // we want this to autoplay
      player.me.autoplay = true;
      var MSE = false;

      // setTimeout(function () {
      //   player.tech_.play();
      // }, 0)

      var startPlay = function () {
        var $playBtn = $('.vjs-big-play-button');
        if ($('.vjs-big-play-button').is(':visible')) {
          player.play();
          setTimeout(startPlay, 100)
        }
      };

      setTimeout(startPlay, 100);
    }

    // initialize autoplay toggle
    autoplayToggleButton(turnOn);

    // set up toggle click
    autoplayBtn.onclick = function () {
      // check if key in storage and do the opposite of that to toggle
      var toggle = storage.getItem(key) === 'yes' ? false:true;
      autoplayToggleButton(toggle);
    };

    // return player to allow this plugin to be chained
    return player;

  };

  // set this thing up as a vjs plugin
  videojs.plugin('autoplayToggle', autoplayToggle);

  // alternative function for retrieving autoplay value from storage for situations where other plugins
  //  are interfering with this plugin
  videojs.autoplaySettingFromStorage = function (options) {
    var settings = extend({}, defaults, options || {}),
        key = settings.namespace + '-autoplay';

    // negate what's in storage since only "don't autoplay" is stored
    return !storage.getItem(key);
  };

})(window, document, videojs);
