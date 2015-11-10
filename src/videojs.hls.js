/*
 * videojs-hls
 * The main file for the HLS project.
 * License: https://github.com/videojs/videojs-contrib-hls/blob/master/LICENSE
 */
(function(window, videojs, document, undefined) {
'use strict';

var
  // a fudge factor to apply to advertised playlist bitrates to account for
  // temporary flucations in client bandwidth
  bandwidthVariance = 1.1,
  Component = videojs.getComponent('Component'),

  // the amount of time to wait between checking the state of the buffer
  bufferCheckInterval = 500,

  keyFailed,
  resolveUrl;

// returns true if a key has failed to download within a certain amount of retries
keyFailed = function(key) {
  return key.retries && key.retries >= 2;
};

videojs.Hls = videojs.extend(Component, {
  constructor: function(tech, options) {
    var self = this, _player;

    Component.call(this, tech);

    // tech.player() is deprecated but setup a reference to HLS for
    // backwards-compatibility
    if (tech.options_ && tech.options_.playerId) {
      _player = videojs(tech.options_.playerId);
      if (!_player.hls) {
        Object.defineProperty(_player, 'hls', {
          get: function() {
            videojs.log.warn('player.hls is deprecated. Use player.tech.hls instead.');
            return self;
          }
        });
      }
    }
    this.tech_ = tech;
    this.source_ = options.source;
    this.mode_ = options.mode;
    // the segment info object for a segment that is in the process of
    // being downloaded or processed
    this.pendingSegment_ = null;

    this.bytesReceived = 0;

    // loadingState_ tracks how far along the buffering process we
    // have been given permission to proceed. There are three possible
    // values:
    // - none: do not load playlists or segments
    // - meta: load playlists but not segments
    // - segments: load everything
    this.loadingState_ = 'none';
    if (this.tech_.preload() !== 'none') {
      this.loadingState_ = 'meta';
    }

    // periodically check if new data needs to be downloaded or
    // buffered data should be appended to the source buffer
    this.startCheckingBuffer_();

    this.on(this.tech_, 'seeking', function() {
      this.setCurrentTime(this.tech_.currentTime());
    });
    this.on(this.tech_, 'error', function() {
      console.log('error stop');
      this.stopCheckingBuffer_();
    });

    this.on(this.tech_, 'play', this.play);
  }
});

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
videojs.Hls.canPlaySource = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

/**
 * The Source Handler object, which informs video.js what additional
 * MIME types are supported and sets up playback. It is registered
 * automatically to the appropriate tech based on the capabilities of
 * the browser it is running in. It is not necessary to use or modify
 * this object in normal usage.
 */
videojs.HlsSourceHandler = function(mode) {
  return {
    canHandleSource: function(srcObj) {
      var mpegurlRE = /^application\/(?:x-|vnd\.apple\.)mpegurl/i;

      // favor native HLS support if it's available
      if (videojs.Hls.supportsNativeHls) {
        return false;
      }
      return mpegurlRE.test(srcObj.type);
    },
    handleSource: function(source, tech) {
      if (mode === 'flash') {
        // We need to trigger this asynchronously to give others the chance
        // to bind to the event when a source is set at player creation
        tech.setTimeout(function() {
          tech.trigger('loadstart');
        }, 1);
      }
      tech.hls = new videojs.Hls(tech, {
        source: source,
        mode: mode
      });
      tech.hls.src(source.src);
      return tech.hls;
    }
  };
};

// register source handlers with the appropriate techs
if (videojs.MediaSource.supportsNativeMediaSources()) {
  videojs.getComponent('Html5').registerSourceHandler(videojs.HlsSourceHandler('html5'));
}
videojs.getComponent('Flash').registerSourceHandler(videojs.HlsSourceHandler('flash'));

// the desired length of video to maintain in the buffer, in seconds
videojs.Hls.GOAL_BUFFER_LENGTH = 30;

videojs.Hls.prototype.src = function(src) {
  var oldMediaPlaylist;

  // do nothing if the src is falsey
  if (!src) {
    return;
  }

  this.mediaSource = new videojs.MediaSource({ mode: this.mode_ });

  // load the MediaSource into the player
  this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen.bind(this));

  this.options_ = {};
  if (this.source_.withCredentials !== undefined) {
    this.options_.withCredentials = this.source_.withCredentials;
  } else if (videojs.options.hls) {
    this.options_.withCredentials = videojs.options.hls.withCredentials;
  }
  this.playlists = new videojs.Hls.PlaylistLoader(this.source_.src, this.options_.withCredentials);

  this.playlists.on('loadedmetadata', function() {
    oldMediaPlaylist = this.playlists.media();

    // if this isn't a live video and preload permits, start
    // downloading segments
    if (oldMediaPlaylist.endList &&
        this.tech_.preload() !== 'metadata' &&
        this.tech_.preload() !== 'none') {
      this.loadingState_ = 'segments';
    }

    this.setupSourceBuffer_();
    this.setupFirstPlay();
    this.fillBuffer();
    this.tech_.trigger('loadedmetadata');
  }.bind(this));

  this.playlists.on('error', function() {
    console.log('this.playlists.on(');
    // close the media source with the appropriate error type
    if (this.playlists.error.code === 2) {
      this.mediaSource.endOfStream('network');
    } else if (this.playlists.error.code === 4) {
      this.mediaSource.endOfStream('decode');
    }

    // if this error is unrecognized, pass it along to the tech
    this.tech_.error(this.playlists.error);
  }.bind(this));

  this.playlists.on('loadedplaylist', function() {
    var updatedPlaylist = this.playlists.media();

    if (!updatedPlaylist) {
      // select the initial variant
      this.playlists.media(this.selectPlaylist());
      return;
    }

    this.updateDuration(this.playlists.media());
    oldMediaPlaylist = updatedPlaylist;
  }.bind(this));

  this.playlists.on('mediachange', function() {
    this.tech_.trigger({
      type: 'mediachange',
      bubbles: true
    });
  }.bind(this));

  // do nothing if the tech has been disposed already
  // this can occur if someone sets the src in player.ready(), for instance
  if (!this.tech_.el()) {
    return;
  }

  this.tech_.src(videojs.URL.createObjectURL(this.mediaSource));
};

videojs.Hls.prototype.handleSourceOpen = function() {
  // Only attempt to create the source buffer if none already exist.
  // handleSourceOpen is also called when we are "re-opening" a source buffer
  // after `endOfStream` has been called (in response to a seek for instance)
  if (!this.sourceBuffer) {
    this.setupSourceBuffer_();
  }

  // if autoplay is enabled, begin playback. This is duplicative of
  // code in video.js but is required because play() must be invoked
  // *after* the media source has opened.
  // NOTE: moving this invocation of play() after
  // sourceBuffer.appendBuffer() below caused live streams with
  // autoplay to stall
  if (this.tech_.autoplay()) {
    this.play();
  }
};

// Returns the array of time range edge objects that were additively
// modified between two TimeRanges.
videojs.Hls.bufferedAdditions_ = function(original, update) {
  var result = [], edges = [],
      i, inOriginalRanges;

  // if original or update are falsey, return an empty list of
  // additions
  if (!original || !update) {
    return result;
  }

  // create a sorted array of time range start and end times
  for (i = 0; i < original.length; i++) {
    edges.push({ original: true, start: original.start(i) });
    edges.push({ original: true, end: original.end(i) });
  }
  for (i = 0; i < update.length; i++) {
    edges.push({ start: update.start(i) });
    edges.push({ end: update.end(i) });
  }
  edges.sort(function(left, right) {
    var leftTime, rightTime;
    leftTime = left.start !== undefined ? left.start : left.end;
    rightTime = right.start !== undefined ? right.start : right.end;

    // when two times are equal, ensure the original edge covers the
    // update
    if (leftTime === rightTime) {
      if (left.original) {
        return left.start !== undefined ? -1 : 1;
      }
      return right.start !== undefined ? -1 : 1;
    }
    return leftTime - rightTime;
  });

  // filter out all time range edges that occur during a period that
  // was already covered by `original`
  inOriginalRanges = false;
  for (i = 0; i < edges.length; i++) {
    // if this is a transition point for `original`, track whether
    // subsequent edges are additions
    if (edges[i].original) {
      inOriginalRanges = edges[i].start !== undefined;
      continue;
    }
    // if we're in a time range that was in `original`, ignore this edge
    if (inOriginalRanges) {
      continue;
    }
    // this edge occurred outside the range of `original`
    result.push(edges[i]);
  }
  return result;
};

videojs.Hls.prototype.setupSourceBuffer_ = function() {
  var media = this.playlists.media(), mimeType;

  // wait until a media playlist is available and the Media Source is
  // attached
  if (!media || this.mediaSource.readyState !== 'open') {
    return;
  }

  // if the codecs were explicitly specified, pass them along to the
  // source buffer
  mimeType = 'video/mp2t';
  if (media.attributes && media.attributes.CODECS) {
    mimeType += '; codecs="' + media.attributes.CODECS + '"';
  }
  this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

  // transition the sourcebuffer to the ended state if we've hit the end of
  // the playlist
  this.sourceBuffer.addEventListener('updateend', function() {
    var segmentInfo = this.pendingSegment_, segment, currentBuffered, timelineUpdates;

    this.pendingSegment_ = null;

    // if we've buffered to the end of the video, let the MediaSource know
    currentBuffered = this.findCurrentBuffered_();
    if (currentBuffered.length && this.duration() === currentBuffered.end(0)) {
      this.mediaSource.endOfStream();
    }

    // stop here if the update errored or was aborted
    if (!segmentInfo) {
      return;
    }

    // annotate the segment with any start and end time information
    // added by the media processing
    segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];
    timelineUpdates = videojs.Hls.bufferedAdditions_(segmentInfo.buffered,
                                                     this.tech_.buffered());
    timelineUpdates.forEach(function(update) {
      if (update.start !== undefined) {
        segment.start = update.start;
      }
      if (update.end !== undefined) {
        segment.end = update.end;
      }
    });

    if (timelineUpdates.length) {
      this.updateDuration(segmentInfo.playlist);
    }

    // check if it's time to download the next segment
    this.checkBuffer_();
  }.bind(this));
};

/**
 * Seek to the latest media position if this is a live video and the
 * player and video are loaded and initialized.
 */
videojs.Hls.prototype.setupFirstPlay = function() {
  var seekable, media;
  media = this.playlists.media();

  // check that everything is ready to begin buffering

  // 1) the video is a live stream of unknown duration
  if (this.duration() === Infinity &&

      // 2) the player has not played before and is not paused
      this.tech_.played().length === 0 &&
      !this.tech_.paused() &&

      // 3) the Media Source and Source Buffers are ready
      this.sourceBuffer &&

      // 4) the active media playlist is available
      media) {

    // seek to the latest media position for live videos
    seekable = this.seekable();
    if (seekable.length) {
      this.tech_.setCurrentTime(seekable.end(0));
    }
  }
};

/**
 * Begin playing the video.
 */
videojs.Hls.prototype.play = function() {
  this.loadingState_ = 'segments';

  if (this.tech_.ended()) {
    this.tech_.setCurrentTime(0);
  }

  if (this.tech_.played().length === 0) {
    return this.setupFirstPlay();
  }

  // if the viewer has paused and we fell out of the live window,
  // seek forward to the earliest available position
  if (this.duration() === Infinity) {
    if (this.tech_.currentTime() < this.tech_.seekable().start(0)) {
      this.tech_.setCurrentTime(this.tech_.seekable().start(0));
    }
  }
};

videojs.Hls.prototype.setCurrentTime = function(currentTime) {
  var
    buffered = this.findCurrentBuffered_();

  if (!(this.playlists && this.playlists.media())) {
    // return immediately if the metadata is not ready yet
    return 0;
  }

  // it's clearly an edge-case but don't thrown an error if asked to
  // seek within an empty playlist
  if (!this.playlists.media().segments) {
    return 0;
  }

  // if the seek location is already buffered, continue buffering as
  // usual
  if (buffered && buffered.length) {
    return currentTime;
  }

  // cancel outstanding requests and buffer appends
  this.cancelSegmentXhr();

  // abort outstanding key requests, if necessary
  if (this.keyXhr_) {
    this.keyXhr_.aborted = true;
    this.cancelKeyXhr();
  }

  // clear out the segment being processed
  this.pendingSegment_ = null;

  // begin filling the buffer at the new position
  this.fillBuffer(currentTime);
};

videojs.Hls.prototype.duration = function() {
  var playlists = this.playlists;
  if (playlists) {
    return videojs.Hls.Playlist.duration(playlists.media());
  }
  return 0;
};

videojs.Hls.prototype.seekable = function() {
  var media;

  if (!this.playlists) {
    return videojs.createTimeRanges();
  }
  media = this.playlists.media();
  if (!media) {
    return videojs.createTimeRanges();
  }

  return videojs.Hls.Playlist.seekable(media);
};

/**
 * Update the player duration
 */
videojs.Hls.prototype.updateDuration = function(playlist) {
  var oldDuration = this.mediaSource.duration,
      newDuration = videojs.Hls.Playlist.duration(playlist),
      setDuration = function() {
        this.mediaSource.duration = newDuration;
        this.tech_.trigger('durationchange');
        this.mediaSource.removeEventListener('sourceopen', setDuration);
      }.bind(this);

  // if the duration has changed, invalidate the cached value
  if (oldDuration !== newDuration) {
    if (this.mediaSource.readyState === 'open') {
      this.mediaSource.duration = newDuration;
      this.tech_.trigger('durationchange');
    } else {
      this.mediaSource.addEventListener('sourceopen', setDuration);
    }
  }
};

/**
 * Clear all buffers and reset any state relevant to the current
 * source. After this function is called, the tech should be in a
 * state suitable for switching to a different video.
 */
videojs.Hls.prototype.resetSrc_ = function() {
  this.cancelSegmentXhr();
  this.cancelKeyXhr();

  if (this.sourceBuffer) {
    this.sourceBuffer.abort();
  }
};

videojs.Hls.prototype.cancelKeyXhr = function() {
  if (this.keyXhr_) {
    this.keyXhr_.onreadystatechange = null;
    this.keyXhr_.abort();
    this.keyXhr_ = null;
  }
};

videojs.Hls.prototype.cancelSegmentXhr = function() {
  if (this.segmentXhr_) {
    // Prevent error handler from running.
    this.segmentXhr_.onreadystatechange = null;
    this.segmentXhr_.abort();
    this.segmentXhr_ = null;
  }
};

/**
 * Abort all outstanding work and cleanup.
 */
videojs.Hls.prototype.dispose = function() {
  this.stopCheckingBuffer_();

  if (this.playlists) {
    this.playlists.dispose();
  }

  this.resetSrc_();
  Component.prototype.dispose.call(this);
};

/**
 * Chooses the appropriate media playlist based on the current
 * bandwidth estimate and the player size.
 * @return the highest bitrate playlist less than the currently detected
 * bandwidth, accounting for some amount of bandwidth variance
 */
videojs.Hls.prototype.selectPlaylist = function () {
  var
    effectiveBitrate,
    sortedPlaylists = this.playlists.master.playlists.slice(),
    bandwidthPlaylists = [],
    i = sortedPlaylists.length,
    variant,
    oldvariant,
    bandwidthBestVariant,
    resolutionPlusOne,
    resolutionBestVariant,
    width,
    height;

  sortedPlaylists.sort(videojs.Hls.comparePlaylistBandwidth);

  // filter out any variant that has greater effective bitrate
  // than the current estimated bandwidth
  while (i--) {
    variant = sortedPlaylists[i];

    // ignore playlists without bandwidth information
    if (!variant.attributes || !variant.attributes.BANDWIDTH) {
      continue;
    }

    effectiveBitrate = variant.attributes.BANDWIDTH * bandwidthVariance;

    if (effectiveBitrate < this.bandwidth) {
      bandwidthPlaylists.push(variant);

      // since the playlists are sorted in ascending order by
      // bandwidth, the first viable variant is the best
      if (!bandwidthBestVariant) {
        bandwidthBestVariant = variant;
      }
    }
  }

  i = bandwidthPlaylists.length;

  // sort variants by resolution
  bandwidthPlaylists.sort(videojs.Hls.comparePlaylistResolution);

  // forget our old variant from above, or we might choose that in high-bandwidth scenarios
  // (this could be the lowest bitrate rendition as  we go through all of them above)
  variant = null;

  width = parseInt(getComputedStyle(this.tech_.el()).width, 10);
  height = parseInt(getComputedStyle(this.tech_.el()).height, 10);

  // iterate through the bandwidth-filtered playlists and find
  // best rendition by player dimension
  while (i--) {
    oldvariant = variant;
    variant = bandwidthPlaylists[i];

    // ignore playlists without resolution information
    if (!variant.attributes ||
        !variant.attributes.RESOLUTION ||
        !variant.attributes.RESOLUTION.width ||
        !variant.attributes.RESOLUTION.height) {
      continue;
    }


    // since the playlists are sorted, the first variant that has
    // dimensions less than or equal to the player size is the best
    if (variant.attributes.RESOLUTION.width === width &&
        variant.attributes.RESOLUTION.height === height) {
      // if we have the exact resolution as the player use it
      resolutionPlusOne = null;
      resolutionBestVariant = variant;
      break;
    } else if (variant.attributes.RESOLUTION.width < width &&
        variant.attributes.RESOLUTION.height < height) {
      // if we don't have an exact match, see if we have a good higher quality variant to use
      if (oldvariant && oldvariant.attributes && oldvariant.attributes.RESOLUTION &&
          oldvariant.attributes.RESOLUTION.width && oldvariant.attributes.RESOLUTION.height) {
        resolutionPlusOne = oldvariant;
      }
      resolutionBestVariant = variant;
      break;
    }
  }

  // fallback chain of variants
  return resolutionPlusOne || resolutionBestVariant || bandwidthBestVariant || sortedPlaylists[0];
};

/**
 * Periodically request new segments and append video data.
 */
videojs.Hls.prototype.checkBuffer_ = function() {
  // calling this method directly resets any outstanding buffer checks
  if (this.checkBufferTimeout_) {
    window.clearTimeout(this.checkBufferTimeout_);
    this.checkBufferTimeout_ = null;
  }

  this.fillBuffer();
  this.drainBuffer();

  // wait awhile and try again
  this.checkBufferTimeout_ = window.setTimeout((this.checkBuffer_).bind(this),
                                               bufferCheckInterval);
};

/**
 * Setup a periodic task to request new segments if necessary and
 * append bytes into the SourceBuffer.
 */
videojs.Hls.prototype.startCheckingBuffer_ = function() {
  // if the player ever stalls, check if there is video data available
  // to append immediately
  this.tech_.on('waiting', (this.drainBuffer).bind(this));

  this.checkBuffer_();
};

/**
 * Stop the periodic task requesting new segments and feeding the
 * SourceBuffer.
 */
videojs.Hls.prototype.stopCheckingBuffer_ = function() {
  if (this.checkBufferTimeout_) {
    window.clearTimeout(this.checkBufferTimeout_);
    this.checkBufferTimeout_ = null;
  }
  this.tech_.off('waiting', this.drainBuffer);
};

/**
 * Attempts to find the buffered TimeRange where playback is currently
 * happening. Returns a new TimeRange with one or zero ranges.
 */
videojs.Hls.prototype.findCurrentBuffered_ = function() {
  var
    tech = this.tech_,
    currentTime = tech.currentTime(),
    buffered = this.tech_.buffered(),
    ranges,
    i;

  var _player = videojs(tech.options_.playerId);

  if (buffered && buffered.length) {
    // Search for a range containing the play-head
    for (i = 0; i < buffered.length; i++) {
      currentTime = Math.ceil(currentTime*10)/10;

      if (buffered.length === 1) {
          buffered
      }

// console.log(buffered.start(i), buffered.end(i), currentTime);

      if (i>0) {
        if (currentTime >= buffered.end(i-1) && currentTime < buffered.start(i) ) {
          this.tech_.setCurrentTime(buffered.start(i));
        }
      }

      if (buffered.length === 1 && currentTime < buffered.start(i)) {
         this.tech_.setCurrentTime(buffered.start(i));
      }

      if (buffered.start(i) <= currentTime &&
          buffered.end(i) > currentTime) {
        ranges = videojs.createTimeRanges(buffered.start(i), buffered.end(i));
        ranges.indexOf = i;

        _player.removeClass('vjs-waiting');
        return ranges;
      }
    }
  }

  /**
   * 没有资源时，加上waiting状态
   * @author hooke
   */

  if (_player.hasStarted()) {
    _player.handleTechWaiting_();
  }

  // console.log('empty ranges', currentTime, _player.hls.playlists.master.playlists[0].segments);

  // Return an empty range if no ranges exist
  ranges = videojs.createTimeRanges();
  ranges.indexOf = -1;
  return ranges;
};

/**
 * Determines whether there is enough video data currently in the buffer
 * and downloads a new segment if the buffered time is less than the goal.
 * @param seekToTime (optional) {number} the offset into the downloaded segment
 * to seek to, in seconds
 */
videojs.Hls.prototype.fillBuffer = function(seekToTime) {
  var
    tech = this.tech_,
    currentTime = tech.currentTime(),
    currentBuffered = this.findCurrentBuffered_(),
    bufferedTime = 0,
    mediaIndex = 0,
    segment,
    segmentInfo;

  // if preload is set to "none", do not download segments until playback is requested
  if (this.loadingState_ !== 'segments') {
    return;
  }

  // if a video has not been specified, do nothing
  if (!tech.currentSrc() || !this.playlists) {
    return;
  }

  // if there is a request already in flight, do nothing
  if (this.segmentXhr_) {
    return;
  }

  // wait until the buffer is up to date
  if (this.pendingSegment_) {
    return;
  }

  // if no segments are available, do nothing
  if (this.playlists.state === "HAVE_NOTHING" ||
      !this.playlists.media() ||
      !this.playlists.media().segments) {
    return;
  }

  // if a playlist switch is in progress, wait for it to finish
  if (this.playlists.state === 'SWITCHING_MEDIA') {
    return;
  }
  // find the next segment to download
  // if (typeof seekToTime === 'number') {
  //   mediaIndex = this.playlists.getMediaIndexForTime_(seekToTime);
  // } else if (currentBuffered && currentBuffered.length) {
  //   mediaIndex = this.playlists.getMediaIndexForTime_(currentBuffered.end(0));
  //   bufferedTime = Math.max(0, currentBuffered.end(0) - currentTime);
  // } else {
  //   mediaIndex = this.playlists.getMediaIndexForTime_(this.tech_.currentTime());
  // }

  /**
   * hooke
   * 不得已而为之
   */
  // if (this.lastMediaIndex !== undefined) {
  //   if (this.lastMediaIndex >= mediaIndex) {
  //     mediaIndex = this.lastMediaIndex + 1;
  //
  //     if (mediaIndex + 1 > this.playlists.media().segments.length) {
  //       mediaIndex = this.playlists.media().segments.length - 1;
  //     }
  //
  //   }
  // }
  //
  // this.lastMediaIndex = mediaIndex;

  if (this.lastMediaIndex === undefined) {
      this.lastMediaIndex = 0;
  } else {
      this.lastMediaIndex++;
  }

  mediaIndex = this.lastMediaIndex;

  console.log('mediaindex', mediaIndex);

  segment = this.playlists.media().segments[mediaIndex];


  // if the video has finished downloading, stop trying to buffer
  if (!segment) {
    this.lastMediaIndex--;
    return;
  }
// console.log(this.lastLoadSegmentUrl);
  if (this.lastLoadSegmentUrl) {
    while(this.lastLoadSegmentUrl.indexOf(segment.uri.split('.ts')[0]) >= 0) {
      mediaIndex++;
      if (mediaIndex < this.playlists.media().segments.length){
        segment = this.playlists.media().segments[mediaIndex];
      } else {
        break;
      }
    }
  }

  // if there is plenty of content in the buffer and we're not
  // seeking, relax for awhile
  if (typeof seekToTime !== 'number' &&
      bufferedTime >= videojs.Hls.GOAL_BUFFER_LENGTH) {
    return;
  }

  // package up all the work to append the segment
  segmentInfo = {
    // resolve the segment URL relative to the playlist
    uri: this.playlistUriToUrl(segment.uri),
    // the segment's mediaIndex at the time it was received
    mediaIndex: mediaIndex,
    // the segment's playlist
    playlist: this.playlists.media(),
    // optionally, a time offset to seek to within the segment
    offset: seekToTime,
    // unencrypted bytes of the segment
    bytes: null,
    // when a key is defined for this segment, the encrypted bytes
    encryptedBytes: null,
    // optionally, the decrypter that is unencrypting the segment
    decrypter: null,
    // the state of the buffer before a segment is appended will be
    // stored here so that the actual segment duration can be
    // determined after it has been appended
    buffered: null
  };
  this.loadSegment(segmentInfo);
};

videojs.Hls.prototype.playlistUriToUrl = function(segmentRelativeUrl) {
  var playListUrl;
    // resolve the segment URL relative to the playlist
  if (this.playlists.media().uri === this.source_.src) {
    playListUrl = resolveUrl(this.source_.src, segmentRelativeUrl);
  } else {
    playListUrl = resolveUrl(resolveUrl(this.source_.src, this.playlists.media().uri || ''), segmentRelativeUrl);
  }
  return playListUrl;
};

/*
 * Sets `bandwidth`, `segmentXhrTime`, and appends to the `bytesReceived.
 * Expects an object with:
 *  * `roundTripTime` - the round trip time for the request we're setting the time for
 *  * `bandwidth` - the bandwidth we want to set
 *  * `bytesReceived` - amount of bytes downloaded
 * `bandwidth` is the only required property.
 */
videojs.Hls.prototype.setBandwidth = function(xhr) {
  // calculate the download bandwidth
  this.segmentXhrTime = xhr.roundTripTime;
  this.bandwidth = xhr.bandwidth;
  this.bytesReceived += xhr.bytesReceived || 0;

  this.tech_.trigger('bandwidthupdate');
};

videojs.Hls.prototype.loadSegment = function(segmentInfo) {
  var simpleUri = segmentInfo.uri.split('.ts')[0];
  // simpleUri = simpleUri.split('http://tblivestream.baidu.com/live/')[1];

  if (this.lastLoadSegmentUrl === undefined) {
    this.lastLoadSegmentUrl = [simpleUri];
  } else if (this.lastLoadSegmentUrl.indexOf(simpleUri) >=0 ) {
    return;
  }

  this.lastLoadSegmentUrl.push(simpleUri);

  var
    self = this,
    segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];

  // if the segment is encrypted, request the key
  if (segment.key) {
    this.fetchKey_(segment);
  }

  // request the next segment
  this.segmentXhr_ = videojs.Hls.xhr({
    uri: segmentInfo.uri,
    responseType: 'arraybuffer',
    withCredentials: this.source_.withCredentials
  }, function(error, request) {

    // the segment request is no longer outstanding
    self.segmentXhr_ = null;

    // if a segment request times out, we may have better luck with another playlist
    if (request.timedout) {
      self.bandwidth = 1;
      return self.playlists.media(self.selectPlaylist());
    }

    // otherwise, trigger a network error
    if (!request.aborted && error) {
      self.error = {
        status: request.status,
        message: 'HLS segment request error at URL: ' + segmentInfo.uri,
        code: (request.status >= 500) ? 4 : 2
      };

      return self.mediaSource.endOfStream('network');
    }

    // stop processing if the request was aborted
    if (!request.response) {
      return;
    }

    self.setBandwidth(request);
    if (segment.key) {
      segmentInfo.encryptedBytes = new Uint8Array(request.response);
    } else {
      segmentInfo.bytes = new Uint8Array(request.response);
    }
    self.pendingSegment_ = segmentInfo;
    self.tech_.trigger('progress');
    self.drainBuffer();

    // figure out what stream the next segment should be downloaded from
    // with the updated bandwidth information
    self.playlists.media(self.selectPlaylist());
  });
};

videojs.Hls.prototype.drainBuffer = function(event) {
  var
    segmentInfo,
    mediaIndex,
    playlist,
    offset,
    bytes,
    segment,
    decrypter,
    segIv,
    segmentTimestampOffset = 0,
    hasBufferedContent = (this.tech_.buffered().length !== 0),
    currentBuffered = this.findCurrentBuffered_(),
    outsideBufferedRanges = !(currentBuffered && currentBuffered.length);

  // if the buffer is empty or the source buffer hasn't been created
  // yet, do nothing
  if (!this.pendingSegment_ || !this.sourceBuffer) {
    return;
  }

  // we can't append more data if the source buffer is busy processing
  // what we've already sent
  if (this.sourceBuffer.updating) {
    return;
  }

  segmentInfo = this.pendingSegment_;
  mediaIndex = segmentInfo.mediaIndex;
  playlist = segmentInfo.playlist;
  offset = segmentInfo.offset;
  bytes = segmentInfo.bytes;
  segment = playlist.segments[mediaIndex];

  if (segment.key && !bytes) {

    // this is an encrypted segment
    // if the key download failed, we want to skip this segment
    // but if the key hasn't downloaded yet, we want to try again later
    if (keyFailed(segment.key)) {
      videojs.log.warn('Network error retrieving key from "' +
                       segment.key.uri + '"');
      return this.mediaSource.endOfStream('network');
    } else if (!segment.key.bytes) {

      // waiting for the key bytes, try again later
      return;
    } else if (segmentInfo.decrypter) {

      // decryption is in progress, try again later
      return;
    } else {

      // if the media sequence is greater than 2^32, the IV will be incorrect
      // assuming 10s segments, that would be about 1300 years
      segIv = segment.key.iv || new Uint32Array([0, 0, 0, mediaIndex + playlist.mediaSequence]);

      // create a decrypter to incrementally decrypt the segment
      decrypter = new videojs.Hls.Decrypter(segmentInfo.encryptedBytes,
                                            segment.key.bytes,
                                            segIv,
                                            function(err, bytes) {
                                              segmentInfo.bytes = bytes;
                                            });
      segmentInfo.decrypter = decrypter;
      return;
    }
  }

  event = event || {};

  // If we have seeked into a non-buffered time-range, remove all buffered
  // time-ranges because they could have been incorrectly placed originally
  if (this.tech_.seeking() && outsideBufferedRanges) {
    if (hasBufferedContent) {
      // In Chrome, it seems that too many independent buffered time-ranges can
      // cause playback to fail to resume when seeking so just kill all of them
      this.sourceBuffer.remove(0, Infinity);
      return;
    }

    // If there are discontinuities in the playlist, we can't be sure of anything
    // related to time so we reset the timestamp offset and start appending data
    // anew on every seek
    if (segmentInfo.playlist.discontinuityStarts.length) {
      if (segmentInfo.mediaIndex > 0) {
        segmentTimestampOffset = videojs.Hls.Playlist.duration(segmentInfo.playlist, segmentInfo.mediaIndex);
      }

      // Now that the forward buffer is clear, we have to set timestamp offset to
      // the start of the buffered region
      this.sourceBuffer.timestampOffset = segmentTimestampOffset;
    }
  } else if (segment.discontinuity) {
    // If we aren't seeking and are crossing a discontinuity, we should set
    // timestampOffset for new segments to be appended the end of the current
    // buffered time-range

    // this.sourceBuffer.timestampOffset = currentBuffered.end(0);

    /**
     * hooke
     * 切换分辨率后重新计时
     */
    this.setCurrentTime(0);
  }

  if (currentBuffered.length) {
    // Chrome 45 stalls if appends overlap the playhead
    try {
      this.sourceBuffer.appendWindowStart = Math.min(this.tech_.currentTime(), currentBuffered.end(0));
    } catch (e) {
      this.sourceBuffer.appendWindowStart = 0;
    }
  } else {
    this.sourceBuffer.appendWindowStart = 0;
  }

  if (this.pendingSegment_) {
      this.pendingSegment_.buffered = this.tech_.buffered();  
  }
  
  // the segment is asynchronously added to the current buffered data
  console.log('bytes', bytes.length);
  this.sourceBuffer.appendBuffer(bytes);
};

/**
 * Attempt to retrieve the key for a particular media segment.
 */
videojs.Hls.prototype.fetchKey_ = function(segment) {
  var key, self, settings, receiveKey;

  // if there is a pending XHR or no segments, don't do anything
  if (this.keyXhr_) {
    return;
  }

  self = this;
  settings = this.options_;

  /**
   * Handle a key XHR response.
   */
  receiveKey = function(key) {
    return function(error, request) {
      var view;
      self.keyXhr_ = null;

      if (error || !request.response || request.response.byteLength !== 16) {
        key.retries = key.retries || 0;
        key.retries++;
        if (!request.aborted) {
          // try fetching again
          self.fetchKey_(segment);
        }
        return;
      }

      view = new DataView(request.response);
      key.bytes = new Uint32Array([
        view.getUint32(0),
        view.getUint32(4),
        view.getUint32(8),
        view.getUint32(12)
      ]);

      // check to see if this allows us to make progress buffering now
      self.checkBuffer_();
    };
  };

  key = segment.key;

  // nothing to do if this segment is unencrypted
  if (!key) {
    return;
  }

  // request the key if the retry limit hasn't been reached
  if (!key.bytes && !keyFailed(key)) {
    this.keyXhr_ = videojs.Hls.xhr({
      uri: this.playlistUriToUrl(key.uri),
      responseType: 'arraybuffer',
      withCredentials: settings.withCredentials
    }, receiveKey(key));
    return;
  }
};

/**
 * Whether the browser has built-in HLS support.
 */
videojs.Hls.supportsNativeHls = (function() {
  var
    video = document.createElement('video'),
    xMpegUrl,
    vndMpeg;

  // native HLS is definitely not supported if HTML5 video isn't
  if (!videojs.getComponent('Html5').isSupported()) {
    return false;
  }

  xMpegUrl = video.canPlayType('application/x-mpegURL');
  vndMpeg = video.canPlayType('application/vnd.apple.mpegURL');
  return (/probably|maybe/).test(xMpegUrl) ||
    (/probably|maybe/).test(vndMpeg);
})();

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
videojs.Hls.isSupported = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

/**
 * A comparator function to sort two playlist object by bandwidth.
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the bandwidth attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the bandwidth of right is greater than left and
 * exactly zero if the two are equal.
 */
videojs.Hls.comparePlaylistBandwidth = function(left, right) {
  var leftBandwidth, rightBandwidth;
  if (left.attributes && left.attributes.BANDWIDTH) {
    leftBandwidth = left.attributes.BANDWIDTH;
  }
  leftBandwidth = leftBandwidth || window.Number.MAX_VALUE;
  if (right.attributes && right.attributes.BANDWIDTH) {
    rightBandwidth = right.attributes.BANDWIDTH;
  }
  rightBandwidth = rightBandwidth || window.Number.MAX_VALUE;

  return leftBandwidth - rightBandwidth;
};

/**
 * A comparator function to sort two playlist object by resolution (width).
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the resolution.width attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the resolution.width of right is greater than left and
 * exactly zero if the two are equal.
 */
videojs.Hls.comparePlaylistResolution = function(left, right) {
  var leftWidth, rightWidth;

  if (left.attributes && left.attributes.RESOLUTION && left.attributes.RESOLUTION.width) {
    leftWidth = left.attributes.RESOLUTION.width;
  }

  leftWidth = leftWidth || window.Number.MAX_VALUE;

  if (right.attributes && right.attributes.RESOLUTION && right.attributes.RESOLUTION.width) {
    rightWidth = right.attributes.RESOLUTION.width;
  }

  rightWidth = rightWidth || window.Number.MAX_VALUE;

  // NOTE - Fallback to bandwidth sort as appropriate in cases where multiple renditions
  // have the same media dimensions/ resolution
  if (leftWidth === rightWidth && left.attributes.BANDWIDTH && right.attributes.BANDWIDTH) {
    return left.attributes.BANDWIDTH - right.attributes.BANDWIDTH;
  } else {
    return leftWidth - rightWidth;
  }
};

/**
 * Constructs a new URI by interpreting a path relative to another
 * URI.
 * @param basePath {string} a relative or absolute URI
 * @param path {string} a path part to combine with the base
 * @return {string} a URI that is equivalent to composing `base`
 * with `path`
 * @see http://stackoverflow.com/questions/470832/getting-an-absolute-url-from-a-relative-one-ie6-issue
 */
resolveUrl = videojs.Hls.resolveUrl = function(basePath, path) {
  // use the base element to get the browser to handle URI resolution
  var
    oldBase = document.querySelector('base'),
    docHead = document.querySelector('head'),
    a = document.createElement('a'),
    base = oldBase,
    oldHref,
    result;

  // prep the document
  if (oldBase) {
    oldHref = oldBase.href;
  } else {
    base = docHead.appendChild(document.createElement('base'));
  }

  base.href = basePath;
  a.href = path;
  result = a.href;

  // clean up
  if (oldBase) {
    oldBase.href = oldHref;
  } else {
    docHead.removeChild(base);
  }
  return result;
};

})(window, window.videojs, document);

(function(videojs) {
  'use strict';

  /**
   * A wrapper for videojs.xhr that tracks bandwidth.
   */
  videojs.Hls.xhr = function(options, callback) {
    // Add a default timeout for all hls requests
    options = videojs.mergeOptions({
       timeout: 45e3
     }, options);
    var request = videojs.xhr(options, function(error, response) {
      if (!error && request.response) {
        request.responseTime = (new Date()).getTime();
        request.roundTripTime = request.responseTime - request.requestTime;
        request.bytesReceived = request.response.byteLength || request.response.length;
        if (!request.bandwidth) {
          request.bandwidth = Math.floor((request.bytesReceived / request.roundTripTime) * 8 * 1000);
        }
      }

      // videojs.xhr now uses a specific code on the error object to signal that a request has
      // timed out errors of setting a boolean on the request object
      if (error || request.timedout) {
        request.timedout = request.timedout || (error.code === 'ETIMEDOUT');
      } else {
        request.timedout = false;
      }

      // videojs.xhr no longer consider status codes outside of 200 and 0 (for file uris) to be
      // errors but the old XHR did so emulate that behavior
      if (!error && response.statusCode !== 200 && response.statusCode !== 0) {
        error = new Error('XHR Failed with a response of: ' +
          (request && (request.response || request.responseText)));
      }

      callback(error, request);
    });

    request.requestTime = (new Date()).getTime();
    return request;
  };
})(window.videojs);

/**
 * A lightweight readable stream implemention that handles event dispatching.
 * Objects that inherit from streams should call init in their constructors.
 */
(function(videojs, undefined) {
  var Stream = function() {
    this.init = function() {
      var listeners = {};
      /**
       * Add a listener for a specified event type.
       * @param type {string} the event name
       * @param listener {function} the callback to be invoked when an event of
       * the specified type occurs
       */
      this.on = function(type, listener) {
        if (!listeners[type]) {
          listeners[type] = [];
        }
        listeners[type].push(listener);
      };
      /**
       * Remove a listener for a specified event type.
       * @param type {string} the event name
       * @param listener {function} a function previously registered for this
       * type of event through `on`
       */
      this.off = function(type, listener) {
        var index;
        if (!listeners[type]) {
          return false;
        }
        index = listeners[type].indexOf(listener);
        listeners[type].splice(index, 1);
        return index > -1;
      };
      /**
       * Trigger an event of the specified type on this stream. Any additional
       * arguments to this function are passed as parameters to event listeners.
       * @param type {string} the event name
       */
      this.trigger = function(type) {
        var callbacks, i, length, args;
        callbacks = listeners[type];
        if (!callbacks) {
          return;
        }
        // Slicing the arguments on every invocation of this method
        // can add a significant amount of overhead. Avoid the
        // intermediate object creation for the common case of a
        // single callback argument
        if (arguments.length === 2) {
          length = callbacks.length;
          for (i = 0; i < length; ++i) {
            callbacks[i].call(this, arguments[1]);
          }
        } else {
          args = Array.prototype.slice.call(arguments, 1);
          length = callbacks.length;
          for (i = 0; i < length; ++i) {
            callbacks[i].apply(this, args);
          }
        }
      };
      /**
       * Destroys the stream and cleans up.
       */
      this.dispose = function() {
        listeners = {};
      };
    };
  };
  /**
   * Forwards all `data` events on this stream to the destination stream. The
   * destination stream should provide a method `push` to receive the data
   * events as they arrive.
   * @param destination {stream} the stream that will receive all `data` events
   * @see http://nodejs.org/api/stream.html#stream_readable_pipe_destination_options
   */
  Stream.prototype.pipe = function(destination) {
    this.on('data', function(data) {
      destination.push(data);
    });
  };

  videojs.Hls.Stream = Stream;
})(window.videojs);

/**
 * Utilities for parsing M3U8 files. If the entire manifest is available,
 * `Parser` will create an object representation with enough detail for managing
 * playback. `ParseStream` and `LineStream` are lower-level parsing primitives
 * that do not assume the entirety of the manifest is ready and expose a
 * ReadableStream-like interface.
 */
(function(videojs, parseInt, isFinite, mergeOptions, undefined) {
  var
    noop = function() {},

    // "forgiving" attribute list psuedo-grammar:
    // attributes -> keyvalue (',' keyvalue)*
    // keyvalue   -> key '=' value
    // key        -> [^=]*
    // value      -> '"' [^"]* '"' | [^,]*
    attributeSeparator = (function() {
      var
        key = '[^=]*',
        value = '"[^"]*"|[^,]*',
        keyvalue = '(?:' + key + ')=(?:' + value + ')';

      return new RegExp('(?:^|,)(' + keyvalue + ')');
    })(),
    parseAttributes = function(attributes) {
      var
        // split the string using attributes as the separator
        attrs = attributes.split(attributeSeparator),
        i = attrs.length,
        result = {},
        attr;

      while (i--) {
        // filter out unmatched portions of the string
        if (attrs[i] === '') {
          continue;
        }

        // split the key and value
        attr = /([^=]*)=(.*)/.exec(attrs[i]).slice(1);
        // trim whitespace and remove optional quotes around the value
        attr[0] = attr[0].replace(/^\s+|\s+$/g, '');
        attr[1] = attr[1].replace(/^\s+|\s+$/g, '');
        attr[1] = attr[1].replace(/^['"](.*)['"]$/g, '$1');
        result[attr[0]] = attr[1];
      }
      return result;
    },
    Stream = videojs.Hls.Stream,
    LineStream,
    ParseStream,
    Parser;

  /**
   * A stream that buffers string input and generates a `data` event for each
   * line.
   */
  LineStream = function() {
    var buffer = '';
    LineStream.prototype.init.call(this);

    /**
     * Add new data to be parsed.
     * @param data {string} the text to process
     */
    this.push = function(data) {
      var nextNewline;

      buffer += data;
      nextNewline = buffer.indexOf('\n');

      for (; nextNewline > -1; nextNewline = buffer.indexOf('\n')) {
        this.trigger('data', buffer.substring(0, nextNewline));
        buffer = buffer.substring(nextNewline + 1);
      }
    };
  };
  LineStream.prototype = new Stream();

  /**
   * A line-level M3U8 parser event stream. It expects to receive input one
   * line at a time and performs a context-free parse of its contents. A stream
   * interpretation of a manifest can be useful if the manifest is expected to
   * be too large to fit comfortably into memory or the entirety of the input
   * is not immediately available. Otherwise, it's probably much easier to work
   * with a regular `Parser` object.
   *
   * Produces `data` events with an object that captures the parser's
   * interpretation of the input. That object has a property `tag` that is one
   * of `uri`, `comment`, or `tag`. URIs only have a single additional
   * property, `line`, which captures the entirety of the input without
   * interpretation. Comments similarly have a single additional property
   * `text` which is the input without the leading `#`.
   *
   * Tags always have a property `tagType` which is the lower-cased version of
   * the M3U8 directive without the `#EXT` or `#EXT-X-` prefix. For instance,
   * `#EXT-X-MEDIA-SEQUENCE` becomes `media-sequence` when parsed. Unrecognized
   * tags are given the tag type `unknown` and a single additional property
   * `data` with the remainder of the input.
   */
  ParseStream = function() {
    ParseStream.prototype.init.call(this);
  };
  ParseStream.prototype = new Stream();
  /**
   * Parses an additional line of input.
   * @param line {string} a single line of an M3U8 file to parse
   */
  ParseStream.prototype.push = function(line) {
    var match, event;

    //strip whitespace
    line = line.replace(/^\s+|\s+$/g, '');
    if (line.length === 0) {
      // ignore empty lines
      return;
    }

    // URIs
    if (line[0] !== '#') {
      this.trigger('data', {
        type: 'uri',
        uri: line
      });
      return;
    }

    // Comments
    if (line.indexOf('#EXT') !== 0) {
      this.trigger('data', {
        type: 'comment',
        text: line.slice(1)
      });
      return;
    }

    //strip off any carriage returns here so the regex matching
    //doesn't have to account for them.
    line = line.replace('\r','');

    // Tags
    match = /^#EXTM3U/.exec(line);
    if (match) {
      this.trigger('data', {
        type: 'tag',
        tagType: 'm3u'
      });
      return;
    }
    match = (/^#EXTINF:?([0-9\.]*)?,?(.*)?$/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'inf'
      };
      if (match[1]) {
        event.duration = parseFloat(match[1]);
      }
      if (match[2]) {
        event.title = match[2];
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-TARGETDURATION:?([0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'targetduration'
      };
      if (match[1]) {
        event.duration = parseInt(match[1], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#ZEN-TOTAL-DURATION:?([0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'totalduration'
      };
      if (match[1]) {
        event.duration = parseInt(match[1], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-VERSION:?([0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'version'
      };
      if (match[1]) {
        event.version = parseInt(match[1], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-MEDIA-SEQUENCE:?(\-?[0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'media-sequence'
      };
      if (match[1]) {
        event.number = parseInt(match[1], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-DISCONTINUITY-SEQUENCE:?(\-?[0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'discontinuity-sequence'
      };
      if (match[1]) {
        event.number = parseInt(match[1], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-PLAYLIST-TYPE:?(.*)?$/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'playlist-type'
      };
      if (match[1]) {
        event.playlistType = match[1];
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-BYTERANGE:?([0-9.]*)?@?([0-9.]*)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'byterange'
      };
      if (match[1]) {
        event.length = parseInt(match[1], 10);
      }
      if (match[2]) {
        event.offset = parseInt(match[2], 10);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-ALLOW-CACHE:?(YES|NO)?/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'allow-cache'
      };
      if (match[1]) {
        event.allowed = !(/NO/).test(match[1]);
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-STREAM-INF:?(.*)$/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'stream-inf'
      };
      if (match[1]) {
        event.attributes = parseAttributes(match[1]);

        if (event.attributes.RESOLUTION) {
          (function() {
            var
              split = event.attributes.RESOLUTION.split('x'),
              resolution = {};
            if (split[0]) {
              resolution.width = parseInt(split[0], 10);
            }
            if (split[1]) {
              resolution.height = parseInt(split[1], 10);
            }
            event.attributes.RESOLUTION = resolution;
          })();
        }
        if (event.attributes.BANDWIDTH) {
          event.attributes.BANDWIDTH = parseInt(event.attributes.BANDWIDTH, 10);
        }
        if (event.attributes['PROGRAM-ID']) {
          event.attributes['PROGRAM-ID'] = parseInt(event.attributes['PROGRAM-ID'], 10);
        }
      }
      this.trigger('data', event);
      return;
    }
    match = (/^#EXT-X-ENDLIST/).exec(line);
    if (match) {
      this.trigger('data', {
        type: 'tag',
        tagType: 'endlist'
      });
      return;
    }
    match = (/^#EXT-X-DISCONTINUITY/).exec(line);
    if (match) {
      this.trigger('data', {
        type: 'tag',
        tagType: 'discontinuity'
      });
      return;
    }
    match = (/^#EXT-X-KEY:?(.*)$/).exec(line);
    if (match) {
      event = {
        type: 'tag',
        tagType: 'key'
      };
      if (match[1]) {
        event.attributes = parseAttributes(match[1]);
        // parse the IV string into a Uint32Array
        if (event.attributes.IV) {
          if (event.attributes.IV.substring(0,2) === '0x') {
            event.attributes.IV = event.attributes.IV.substring(2);
          }

          event.attributes.IV = event.attributes.IV.match(/.{8}/g);
          event.attributes.IV[0] = parseInt(event.attributes.IV[0], 16);
          event.attributes.IV[1] = parseInt(event.attributes.IV[1], 16);
          event.attributes.IV[2] = parseInt(event.attributes.IV[2], 16);
          event.attributes.IV[3] = parseInt(event.attributes.IV[3], 16);
          event.attributes.IV = new Uint32Array(event.attributes.IV);
        }
      }
      this.trigger('data', event);
      return;
    }

    // unknown tag type
    this.trigger('data', {
      type: 'tag',
      data: line.slice(4, line.length)
    });
  };

  /**
   * A parser for M3U8 files. The current interpretation of the input is
   * exposed as a property `manifest` on parser objects. It's just two lines to
   * create and parse a manifest once you have the contents available as a string:
   *
   * ```js
   * var parser = new videojs.m3u8.Parser();
   * parser.push(xhr.responseText);
   * ```
   *
   * New input can later be applied to update the manifest object by calling
   * `push` again.
   *
   * The parser attempts to create a usable manifest object even if the
   * underlying input is somewhat nonsensical. It emits `info` and `warning`
   * events during the parse if it encounters input that seems invalid or
   * requires some property of the manifest object to be defaulted.
   */
  Parser = function() {
    var
      self = this,
      uris = [],
      currentUri = {},
      key;
    Parser.prototype.init.call(this);

    this.lineStream = new LineStream();
    this.parseStream = new ParseStream();
    this.lineStream.pipe(this.parseStream);

    // the manifest is empty until the parse stream begins delivering data
    this.manifest = {
      allowCache: true,
      discontinuityStarts: []
    };

    // update the manifest with the m3u8 entry from the parse stream
    this.parseStream.on('data', function(entry) {
      ({
        tag: function() {
          // switch based on the tag type
          (({
            'allow-cache': function() {
              this.manifest.allowCache = entry.allowed;
              if (!('allowed' in entry)) {
                this.trigger('info', {
                  message: 'defaulting allowCache to YES'
                });
                this.manifest.allowCache = true;
              }
            },
            'byterange': function() {
              var byterange = {};
              if ('length' in entry) {
                currentUri.byterange = byterange;
                byterange.length = entry.length;

                if (!('offset' in entry)) {
                  this.trigger('info', {
                    message: 'defaulting offset to zero'
                  });
                  entry.offset = 0;
                }
              }
              if ('offset' in entry) {
                currentUri.byterange = byterange;
                byterange.offset = entry.offset;
              }
            },
            'endlist': function() {
              this.manifest.endList = true;
            },
            'inf': function() {
              if (!('mediaSequence' in this.manifest)) {
                this.manifest.mediaSequence = 0;
                this.trigger('info', {
                  message: 'defaulting media sequence to zero'
                });
              }
              if (!('discontinuitySequence' in this.manifest)) {
                this.manifest.discontinuitySequence = 0;
                this.trigger('info', {
                  message: 'defaulting discontinuity sequence to zero'
                });
              }
              if (entry.duration >= 0) {
                currentUri.duration = entry.duration;
              }

              this.manifest.segments = uris;

            },
            'key': function() {
              if (!entry.attributes) {
                this.trigger('warn', {
                  message: 'ignoring key declaration without attribute list'
                });
                return;
              }
              // clear the active encryption key
              if (entry.attributes.METHOD === 'NONE') {
                key = null;
                return;
              }
              if (!entry.attributes.URI) {
                this.trigger('warn', {
                  message: 'ignoring key declaration without URI'
                });
                return;
              }
              if (!entry.attributes.METHOD) {
                this.trigger('warn', {
                  message: 'defaulting key method to AES-128'
                });
              }

              // setup an encryption key for upcoming segments
              key = {
                method: entry.attributes.METHOD || 'AES-128',
                uri: entry.attributes.URI
              };

              if (entry.attributes.IV !== undefined) {
                key.iv = entry.attributes.IV;
              }
            },
            'media-sequence': function() {
              if (!isFinite(entry.number)) {
                this.trigger('warn', {
                  message: 'ignoring invalid media sequence: ' + entry.number
                });
                return;
              }
              this.manifest.mediaSequence = entry.number;
            },
            'discontinuity-sequence': function() {
              if (!isFinite(entry.number)) {
                this.trigger('warn', {
                  message: 'ignoring invalid discontinuity sequence: ' + entry.number
                });
                return;
              }
              this.manifest.discontinuitySequence = entry.number;
            },
            'playlist-type': function() {
              if (!(/VOD|EVENT/).test(entry.playlistType)) {
                this.trigger('warn', {
                  message: 'ignoring unknown playlist type: ' + entry.playlist
                });
                return;
              }
              this.manifest.playlistType = entry.playlistType;
            },
            'stream-inf': function() {
              this.manifest.playlists = uris;

              if (!entry.attributes) {
                this.trigger('warn', {
                  message: 'ignoring empty stream-inf attributes'
                });
                return;
              }

              if (!currentUri.attributes) {
                currentUri.attributes = {};
              }
              currentUri.attributes = mergeOptions(currentUri.attributes,
                                                   entry.attributes);
            },
            'discontinuity': function() {
              currentUri.discontinuity = true;
              this.manifest.discontinuityStarts.push(uris.length);
            },
            'targetduration': function() {
              if (!isFinite(entry.duration) || entry.duration < 0) {
                this.trigger('warn', {
                  message: 'ignoring invalid target duration: ' + entry.duration
                });
                return;
              }
              this.manifest.targetDuration = entry.duration;
            },
            'totalduration': function() {
              if (!isFinite(entry.duration) || entry.duration < 0) {
                this.trigger('warn', {
                  message: 'ignoring invalid total duration: ' + entry.duration
                });
                return;
              }
              this.manifest.totalDuration = entry.duration;
            }
          })[entry.tagType] || noop).call(self);
        },
        uri: function() {
          currentUri.uri = entry.uri;
          uris.push(currentUri);

          // if no explicit duration was declared, use the target duration
          if (this.manifest.targetDuration &&
              !('duration' in currentUri)) {
            this.trigger('warn', {
              message: 'defaulting segment duration to the target duration'
            });
            currentUri.duration = this.manifest.targetDuration;
          }
          // annotate with encryption information, if necessary
          if (key) {
            currentUri.key = key;
          }

          // prepare for the next URI
          currentUri = {};
        },
        comment: function() {
          // comments are not important for playback
        }
      })[entry.type].call(self);
    });
  };
  Parser.prototype = new Stream();
  /**
   * Parse the input string and update the manifest object.
   * @param chunk {string} a potentially incomplete portion of the manifest
   */
  Parser.prototype.push = function(chunk) {
    this.lineStream.push(chunk);
  };
  /**
   * Flush any remaining input. This can be handy if the last line of an M3U8
   * manifest did not contain a trailing newline but the file has been
   * completely received.
   */
  Parser.prototype.end = function() {
    // flush any buffered input
    this.lineStream.push('\n');
  };

  window.videojs.m3u8 = {
    LineStream: LineStream,
    ParseStream: ParseStream,
    Parser: Parser
  };
})(window.videojs, window.parseInt, window.isFinite, window.videojs.mergeOptions);

/**
 * Playlist related utilities.
 */
(function(window, videojs) {
  'use strict';

  var DEFAULT_TARGET_DURATION = 10;
  var duration, intervalDuration, optionalMin, optionalMax, seekable;

  // Math.min that will return the alternative input if one of its
  // parameters in undefined
  optionalMin = function(left, right) {
    left = isFinite(left) ? left : Infinity;
    right = isFinite(right) ? right : Infinity;
    return Math.min(left, right);
  };

  // Math.max that will return the alternative input if one of its
  // parameters in undefined
  optionalMax = function(left, right) {
    left = isFinite(left) ? left: -Infinity;
    right = isFinite(right) ? right: -Infinity;
    return Math.max(left, right);
  };

  /**
   * Calculate the media duration from the segments associated with a
   * playlist. The duration of a subinterval of the available segments
   * may be calculated by specifying an end index.
   *
   * @param playlist {object} a media playlist object
   * @param endSequence {number} (optional) an exclusive upper boundary
   * for the playlist.  Defaults to playlist length.
   * @return {number} the duration between the start index and end
   * index.
   */
  intervalDuration = function(playlist, endSequence) {
    var result = 0, segment, targetDuration, i;

    if (endSequence === undefined) {
      endSequence = playlist.mediaSequence + (playlist.segments || []).length;
    }
    if (endSequence < 0) {
      return 0;
    }
    targetDuration = playlist.targetDuration || DEFAULT_TARGET_DURATION;

    i = endSequence - playlist.mediaSequence;
    // if a start time is available for segment immediately following
    // the interval, use it
    segment = playlist.segments[i];
    // Walk backward until we find the latest segment with timeline
    // information that is earlier than endSequence
    if (segment && segment.start !== undefined) {
      return segment.start;
    }
    while (i--) {
      segment = playlist.segments[i];
      if (segment.end !== undefined) {
        return result + segment.end;
      }

      result += (segment.duration || targetDuration);

      if (segment.start !== undefined) {
        return result + segment.start;
      }
    }
    return result;
  };

  /**
   * Calculates the duration of a playlist. If a start and end index
   * are specified, the duration will be for the subset of the media
   * timeline between those two indices. The total duration for live
   * playlists is always Infinity.
   * @param playlist {object} a media playlist object
   * @param endSequence {number} (optional) an exclusive upper
   * boundary for the playlist.  Defaults to the playlist media
   * sequence number plus its length.
   * @param includeTrailingTime {boolean} (optional) if false, the
   * interval between the final segment and the subsequent segment
   * will not be included in the result
   * @return {number} the duration between the start index and end
   * index.
   */
  duration = function(playlist, endSequence, includeTrailingTime) {
    if (!playlist) {
      return 0;
    }

    if (includeTrailingTime === undefined) {
      includeTrailingTime = true;
    }

    // if a slice of the total duration is not requested, use
    // playlist-level duration indicators when they're present
    if (endSequence === undefined) {
      // if present, use the duration specified in the playlist
      if (playlist.totalDuration) {
        return playlist.totalDuration;
      }

      // duration should be Infinity for live playlists
      if (!playlist.endList) {
        return window.Infinity;
      }
    }

    // calculate the total duration based on the segment durations
    return intervalDuration(playlist,
                            endSequence,
                            includeTrailingTime);
  };

  /**
   * Calculates the interval of time that is currently seekable in a
   * playlist. The returned time ranges are relative to the earliest
   * moment in the specified playlist that is still available. A full
   * seekable implementation for live streams would need to offset
   * these values by the duration of content that has expired from the
   * stream.
   * @param playlist {object} a media playlist object
   * @return {TimeRanges} the periods of time that are valid targets
   * for seeking
   */
  seekable = function(playlist) {
    var start, end;

    // without segments, there are no seekable ranges
    if (!playlist.segments) {
      return videojs.createTimeRange();
    }
    // when the playlist is complete, the entire duration is seekable
    if (playlist.endList) {
      return videojs.createTimeRange(0, duration(playlist));
    }

    // live playlists should not expose three segment durations worth
    // of content from the end of the playlist
    // https://tools.ietf.org/html/draft-pantos-http-live-streaming-16#section-6.3.3
    start = intervalDuration(playlist, playlist.mediaSequence);
    end = intervalDuration(playlist,
                           playlist.mediaSequence + playlist.segments.length);
    end -= (playlist.targetDuration || DEFAULT_TARGET_DURATION) * 3;
    end = Math.max(0, end);
    return videojs.createTimeRange(start, end);
  };

  // exports
  videojs.Hls.Playlist = {
    duration: duration,
    seekable: seekable
  };
})(window, window.videojs);

/**
 * playlist-loader
 *
 * A state machine that manages the loading, caching, and updating of
 * M3U8 playlists.
 *
 */
(function(window, videojs) {
  'use strict';
  var
    resolveUrl = videojs.Hls.resolveUrl,
    xhr = videojs.Hls.xhr,
    mergeOptions = videojs.mergeOptions,
    /**
     * Returns a new master playlist that is the result of merging an
     * updated media playlist into the original version. If the
     * updated media playlist does not match any of the playlist
     * entries in the original master playlist, null is returned.
     * @param master {object} a parsed master M3U8 object
     * @param media {object} a parsed media M3U8 object
     * @return {object} a new object that represents the original
     * master playlist with the updated media playlist merged in, or
     * null if the merge produced no change.
     */
    updateMaster = function(master, media) {
      var
        changed = false,
        result = mergeOptions(master, {}),
        i,
        playlist;
      i = master.playlists.length;
      while (i--) {
        playlist = result.playlists[i];
        console.log('url ===', playlist.uri === media.uri);
        if (playlist.uri === media.uri) {
          // consider the playlist unchanged if the number of segments
          // are equal and the media sequence number is unchanged
          if (playlist.segments &&
              media.segments &&
              playlist.segments.length === media.segments.length &&
              playlist.mediaSequence === media.mediaSequence) {
            console.log('updateMaster continue');
            continue;
          }

          result.playlists[i] = mergeOptions(playlist, media);
          result.playlists[media.uri] = result.playlists[i];

          // if the update could overlap existing segment information,
          // merge the two lists
          if (playlist.segments) {
            result.playlists[i].segments = updateSegments(playlist.segments,
                                                          media.segments,
                                                          media.mediaSequence - playlist.mediaSequence);
          }
          changed = true;
        }
      }
      return changed ? result : null;
    },

    /**
     * Returns a new array of segments that is the result of merging
     * properties from an older list of segments onto an updated
     * list. No properties on the updated playlist will be overridden.
     * @param original {array} the outdated list of segments
     * @param update {array} the updated list of segments
     * @param offset {number} (optional) the index of the first update
     * segment in the original segment list. For non-live playlists,
     * this should always be zero and does not need to be
     * specified. For live playlists, it should be the difference
     * between the media sequence numbers in the original and updated
     * playlists.
     * @return a list of merged segment objects
     */
    updateSegments = function(original, update, offset) {
      console.log(original, update, offset);
      // var result = update.slice(), length, i;
      // offset = offset || 0;
      // length = Math.min(original.length, update.length + offset);

      // // for (i = offset; i < length; i++) {
      // //   result[i - offset] = mergeOptions(original[i], result[i - offset]);
      // // }

      // for(var i=offset; i>0; i--) {
      //   if (update[update.length-i] !== undefined) {
      //       original.push(update[update.length-i]);
      //   }
      // }
        
      /**
       * hooke
       * 以上写法会漏掉一些ts
       */
      var index = -1;

      for (var i=0, len = update.length; i < len; i++) {
          var found = false;
          
          for (var j=original.length-1; j > 0; j--) {
              if (update[i].uri === original[j].uri) {
                  found = true;
                  break;
              }              
          }

          if (found === false) {
              index = i;
              break;
          }
      }

      if (index > -1) {
          for (var i = index; i < update.length; i++) {
              original.push(update[i]);
          }     
      }
      
      return original;
    },

    PlaylistLoader = function(srcUrl, withCredentials) {
      var
        loader = this,
        dispose,
        mediaUpdateTimeout,
        request,
        haveMetadata;

      PlaylistLoader.prototype.init.call(this);

      if (!srcUrl) {
        throw new Error('A non-empty playlist URL is required');
      }

      // update the playlist loader's state in response to a new or
      // updated playlist.
      haveMetadata = function(error, xhr, url) {
        var parser, refreshDelay, update;

        loader.setBandwidth(request || xhr);

        // any in-flight request is now finished
        request = null;

        if (error) {
          loader.error = {
            status: xhr.status,
            message: 'HLS playlist request error at URL: ' + url,
            responseText: xhr.responseText,
            code: (xhr.status >= 500) ? 4 : 2
          };
          // playlist.play();
          console.log('error', error, xhr);
          return loader.trigger('error');
        }

        loader.state = 'HAVE_METADATA';

        parser = new videojs.m3u8.Parser();
        parser.push(xhr.responseText);
        parser.end();
        parser.manifest.uri = url;

        // merge this playlist into the master
        update = updateMaster(loader.master, parser.manifest);
        refreshDelay = (parser.manifest.targetDuration || 10) * 1000;
        if (update) {
          loader.master = update;
          loader.updateMediaPlaylist_(parser.manifest);
        } else {
          // if the playlist is unchanged since the last reload,
          // try again after half the target duration
          refreshDelay /= 2;
        }

        // refresh live playlists after a target duration passes
        if (!loader.media().endList) {
          window.clearTimeout(mediaUpdateTimeout);
          mediaUpdateTimeout = window.setTimeout(function() {
            loader.trigger('mediaupdatetimeout');
          }, refreshDelay);
        }

        loader.trigger('loadedplaylist');
      };

      // initialize the loader state
      loader.state = 'HAVE_NOTHING';

      // capture the prototype dispose function
      dispose = this.dispose;

      /**
       * Abort any outstanding work and clean up.
       */
      loader.dispose = function() {
        if (request) {
          request.onreadystatechange = null;
          request.abort();
          request = null;
        }
        window.clearTimeout(mediaUpdateTimeout);
        dispose.call(this);
      };

      /**
       * When called without any arguments, returns the currently
       * active media playlist. When called with a single argument,
       * triggers the playlist loader to asynchronously switch to the
       * specified media playlist. Calling this method while the
       * loader is in the HAVE_NOTHING causes an error to be emitted
       * but otherwise has no effect.
       * @param playlist (optional) {object} the parsed media playlist
       * object to switch to
       */
      loader.media = function(playlist) {
        var startingState = loader.state, mediaChange;
        // getter
        if (!playlist) {
          return loader.media_;
        }

        // setter
        if (loader.state === 'HAVE_NOTHING') {
          throw new Error('Cannot switch media playlist from ' + loader.state);
        }

        // find the playlist object if the target playlist has been
        // specified by URI
        if (typeof playlist === 'string') {
          if (!loader.master.playlists[playlist]) {
            throw new Error('Unknown playlist URI: ' + playlist);
          }
          playlist = loader.master.playlists[playlist];
        }

        mediaChange = !loader.media_ || playlist.uri !== loader.media_.uri;

        // switch to fully loaded playlists immediately
        if (loader.master.playlists[playlist.uri].endList) {
          // abort outstanding playlist requests
          if (request) {
            request.onreadystatechange = null;
            request.abort();
            request = null;
          }
          loader.state = 'HAVE_METADATA';
          loader.media_ = playlist;

          // trigger media change if the active media has been updated
          if (mediaChange) {
            loader.trigger('mediachange');
          }
          return;
        }

        // switching to the active playlist is a no-op
        if (!mediaChange) {
          return;
        }

        loader.state = 'SWITCHING_MEDIA';

        // there is already an outstanding playlist request
        if (request) {
          if (resolveUrl(loader.master.uri, playlist.uri) === request.url) {
            // requesting to switch to the same playlist multiple times
            // has no effect after the first
            return;
          }
          request.onreadystatechange = null;
          request.abort();
          request = null;
        }

        // request the new playlist
        request = xhr({
          uri: resolveUrl(loader.master.uri, playlist.uri),
          withCredentials: withCredentials
        }, function(error, request) {
          haveMetadata(error, request, playlist.uri);

          if (error) {
            return;
          }

          // fire loadedmetadata the first time a media playlist is loaded
          if (startingState === 'HAVE_MASTER') {
            loader.trigger('loadedmetadata');
          } else {
            loader.trigger('mediachange');
          }
        });
      };

      loader.setBandwidth = function(xhr) {
        loader.bandwidth = xhr.bandwidth;
      };

      // live playlist staleness timeout
      loader.on('mediaupdatetimeout', function() {
        if (loader.state !== 'HAVE_METADATA') {
          // only refresh the media playlist if no other activity is going on
          return;
        }

        loader.state = 'HAVE_CURRENT_METADATA';
        request = xhr({
          uri: resolveUrl(loader.master.uri, loader.media().uri),
          withCredentials: withCredentials,
          timeout: 5000
        }, function(error, request) {
          haveMetadata(error, request, loader.media().uri);
        });
      });

      // request the specified URL
      request = xhr({
        uri: srcUrl,
        withCredentials: withCredentials
      }, function(error, req) {
        var parser, i;

        // clear the loader's request reference
        request = null;

        if (error) {
          loader.error = {
            status: req.status,
            message: 'HLS playlist request error at URL: ' + srcUrl,
            responseText: req.responseText,
            code: 2 // MEDIA_ERR_NETWORK
          };
          return loader.trigger('error');
        }

        parser = new videojs.m3u8.Parser();
        parser.push(req.responseText);
        parser.end();

        loader.state = 'HAVE_MASTER';

        parser.manifest.uri = srcUrl;

        // loaded a master playlist
        if (parser.manifest.playlists) {
          loader.master = parser.manifest;

          // setup by-URI lookups
          i = loader.master.playlists.length;
          while (i--) {
            loader.master.playlists[loader.master.playlists[i].uri] = loader.master.playlists[i];
          }

          loader.trigger('loadedplaylist');
          if (!request) {
            // no media playlist was specifically selected so start
            // from the first listed one
            loader.media(parser.manifest.playlists[0]);
          }
          return;
        }

        // loaded a media playlist
        // infer a master playlist if none was previously requested
        loader.master = {
          uri: window.location.href,
          playlists: [{
            uri: srcUrl
          }]
        };
        loader.master.playlists[srcUrl] = loader.master.playlists[0];
        haveMetadata(null, req, srcUrl);
        return loader.trigger('loadedmetadata');
      });
    };
  PlaylistLoader.prototype = new videojs.Hls.Stream();

  /**
   * Update the PlaylistLoader state to reflect the changes in an
   * update to the current media playlist.
   * @param update {object} the updated media playlist object
   */
  PlaylistLoader.prototype.updateMediaPlaylist_ = function(update) {
    this.media_ = this.master.playlists[update.uri];
  };

  /**
   * Determine the index of the segment that contains a specified
   * playback position in the current media playlist. Early versions
   * of the HLS specification require segment durations to be rounded
   * to the nearest integer which means it may not be possible to
   * determine the correct segment for a playback position if that
   * position is within .5 seconds of the segment duration. This
   * function will always return the lower of the two possible indices
   * in those cases.
   *
   * @param time {number} The number of seconds since the earliest
   * possible position to determine the containing segment for
   * @returns {number} The number of the media segment that contains
   * that time position. If the specified playback position is outside
   * the time range of the current set of media segments, the return
   * value will be clamped to the index of the segment containing the
   * closest playback position that is currently available.
   */

  // PlaylistLoader.prototype.getMediaIndexForTime_ = function(time) {
  //   console.log('getMediaIndexForTime_', time);
  //   if (!this.media_) {
  //     return 0;
  //   }

  //   // when the requested position is earlier than the current set of
  //   // segments, return the earliest segment index
  //   if (time < 0) {
  //     return 0;
  //   }

  //   var i, j, segment, targetDuration;
  //   targetDuration = this.media_.targetDuration || 10;

  //   if (time === 0) {
  //     return 0;
  //   }

  //   for (j = 0; j < this.media_.segments.length; j++) {
  //     segment = this.media_.segments[j];
  //     time -= segment.duration || targetDuration;

  //     if (time < 0) {
  //       console.log('return j;')
  //       return j;
  //     }
  //   }
  // }

  PlaylistLoader.prototype.getMediaIndexForTime_ = function(time) {
    var i, j, segment, targetDuration;

    if (!this.media_) {
      return 0;
    }

    // when the requested position is earlier than the current set of
    // segments, return the earliest segment index
    if (time < 0) {
      return 0;
    }

    // 1) Walk backward until we find the latest segment with timeline
    // information that is earlier than `time`
    targetDuration = this.media_.targetDuration || 10;
    i = this.media_.segments.length;
    while (i--) {
      segment = this.media_.segments[i];

      if (!segment) {
        continue;
      }

      if (i!==0 && segment) {
        // delete segment.start;
        delete segment.end;
      }

      if (segment.end !== undefined && segment.end <= time && segment.start === undefined) {
        if (segment.start && (segment.end > segment.start)) {

        } else {
          time -= segment.end;
          break;
        }
      }
//       if (segment.start !== undefined && segment.start < time) {
// debugger;
//         if (segment.end !== undefined && segment.end > time) {
//           // we've found the target segment exactly
//           return i;
//         }
// console.log(segment.start);
//         time -= segment.start;
//         time -= segment.duration || targetDuration;
//         console.log('inging', segment, time);
//         // if (time < 0) {
//         if (time < 1) {
//           // the segment with start information is also our best guess
//           // for the momment
//           console.log('return i;');
//           return i;
//         }
//         break;
//       }
    }
    i++;

    // 2) Walk forward, testing each segment to see if `time` falls within it
    for (j = i; j < this.media_.segments.length; j++) {
      segment = this.media_.segments[j];
      time -= segment.duration || targetDuration;

      if (time < 0) {
        return j;
      }

      // 2a) If we discover a segment that has timeline information
      // before finding the result segment, the playlist information
      // must have been inaccurate. Start a binary search for the
      // segment which contains `time`. If the guess turns out to be
      // incorrect, we'll have more info to work with next time.
      // if (segment.start !== undefined || segment.end !== undefined) {
      //   return Math.floor((j - i) * 0.5);
      // }
    }

    // the playback position is outside the range of available
    // segments so return the length
    return this.media_.segments.length-1;
  };

  videojs.Hls.PlaylistLoader = PlaylistLoader;
})(window, window.videojs);

(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (global){
global.window.pkcs7 = {
  unpad: require('./unpad')
};

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./unpad":2}],2:[function(require,module,exports){
/*
 * pkcs7.unpad
 * https://github.com/brightcove/pkcs7
 *
 * Copyright (c) 2014 Brightcove
 * Licensed under the apache2 license.
 */

'use strict';

/**
 * Returns the subarray of a Uint8Array without PKCS#7 padding.
 * @param padded {Uint8Array} unencrypted bytes that have been padded
 * @return {Uint8Array} the unpadded bytes
 * @see http://tools.ietf.org/html/rfc5652
 */
module.exports = function unpad(padded) {
  return padded.subarray(0, padded.byteLength - padded[padded.byteLength - 1]);
};

},{}]},{},[1]);
/*
 *
 * This file contains an adaptation of the AES decryption algorithm
 * from the Standford Javascript Cryptography Library. That work is
 * covered by the following copyright and permissions notice:
 *
 * Copyright 2009-2010 Emily Stark, Mike Hamburg, Dan Boneh.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above
 *    copyright notice, this list of conditions and the following
 *    disclaimer in the documentation and/or other materials provided
 *    with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHORS ``AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
 * BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
 * OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN
 * IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * The views and conclusions contained in the software and documentation
 * are those of the authors and should not be interpreted as representing
 * official policies, either expressed or implied, of the authors.
 */
(function(window, videojs, unpad) {
'use strict';

var AES, AsyncStream, Decrypter, decrypt, ntoh;

/**
 * Convert network-order (big-endian) bytes into their little-endian
 * representation.
 */
ntoh = function(word) {
  return (word << 24) |
    ((word & 0xff00) << 8) |
    ((word & 0xff0000) >> 8) |
    (word >>> 24);
};

/**
 * Schedule out an AES key for both encryption and decryption. This
 * is a low-level class. Use a cipher mode to do bulk encryption.
 *
 * @constructor
 * @param key {Array} The key as an array of 4, 6 or 8 words.
 */
AES = function (key) {
  this._precompute();

  var i, j, tmp,
    encKey, decKey,
    sbox = this._tables[0][4], decTable = this._tables[1],
    keyLen = key.length, rcon = 1;

  if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
    throw new Error("Invalid aes key size");
  }

  encKey = key.slice(0);
  decKey = [];
  this._key = [encKey, decKey];

  // schedule encryption keys
  for (i = keyLen; i < 4 * keyLen + 28; i++) {
    tmp = encKey[i-1];

    // apply sbox
    if (i%keyLen === 0 || (keyLen === 8 && i%keyLen === 4)) {
      tmp = sbox[tmp>>>24]<<24 ^ sbox[tmp>>16&255]<<16 ^ sbox[tmp>>8&255]<<8 ^ sbox[tmp&255];

      // shift rows and add rcon
      if (i%keyLen === 0) {
        tmp = tmp<<8 ^ tmp>>>24 ^ rcon<<24;
        rcon = rcon<<1 ^ (rcon>>7)*283;
      }
    }

    encKey[i] = encKey[i-keyLen] ^ tmp;
  }

  // schedule decryption keys
  for (j = 0; i; j++, i--) {
    tmp = encKey[j&3 ? i : i - 4];
    if (i<=4 || j<4) {
      decKey[j] = tmp;
    } else {
      decKey[j] = decTable[0][sbox[tmp>>>24      ]] ^
                  decTable[1][sbox[tmp>>16  & 255]] ^
                  decTable[2][sbox[tmp>>8   & 255]] ^
                  decTable[3][sbox[tmp      & 255]];
    }
  }
};

AES.prototype = {
  /**
   * The expanded S-box and inverse S-box tables. These will be computed
   * on the client so that we don't have to send them down the wire.
   *
   * There are two tables, _tables[0] is for encryption and
   * _tables[1] is for decryption.
   *
   * The first 4 sub-tables are the expanded S-box with MixColumns. The
   * last (_tables[01][4]) is the S-box itself.
   *
   * @private
   */
  _tables: [[[],[],[],[],[]],[[],[],[],[],[]]],

  /**
   * Expand the S-box tables.
   *
   * @private
   */
  _precompute: function () {
   var encTable = this._tables[0], decTable = this._tables[1],
       sbox = encTable[4], sboxInv = decTable[4],
       i, x, xInv, d=[], th=[], x2, x4, x8, s, tEnc, tDec;

    // Compute double and third tables
   for (i = 0; i < 256; i++) {
     th[( d[i] = i<<1 ^ (i>>7)*283 )^i]=i;
   }

   for (x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
     // Compute sbox
     s = xInv ^ xInv<<1 ^ xInv<<2 ^ xInv<<3 ^ xInv<<4;
     s = s>>8 ^ s&255 ^ 99;
     sbox[x] = s;
     sboxInv[s] = x;

     // Compute MixColumns
     x8 = d[x4 = d[x2 = d[x]]];
     tDec = x8*0x1010101 ^ x4*0x10001 ^ x2*0x101 ^ x*0x1010100;
     tEnc = d[s]*0x101 ^ s*0x1010100;

     for (i = 0; i < 4; i++) {
       encTable[i][x] = tEnc = tEnc<<24 ^ tEnc>>>8;
       decTable[i][s] = tDec = tDec<<24 ^ tDec>>>8;
     }
   }

   // Compactify. Considerable speedup on Firefox.
   for (i = 0; i < 5; i++) {
     encTable[i] = encTable[i].slice(0);
     decTable[i] = decTable[i].slice(0);
   }
  },

  /**
   * Decrypt 16 bytes, specified as four 32-bit words.
   * @param encrypted0 {number} the first word to decrypt
   * @param encrypted1 {number} the second word to decrypt
   * @param encrypted2 {number} the third word to decrypt
   * @param encrypted3 {number} the fourth word to decrypt
   * @param out {Int32Array} the array to write the decrypted words
   * into
   * @param offset {number} the offset into the output array to start
   * writing results
   * @return {Array} The plaintext.
   */
  decrypt:function (encrypted0, encrypted1, encrypted2, encrypted3, out, offset) {
    var key = this._key[1],
        // state variables a,b,c,d are loaded with pre-whitened data
        a = encrypted0 ^ key[0],
        b = encrypted3 ^ key[1],
        c = encrypted2 ^ key[2],
        d = encrypted1 ^ key[3],
        a2, b2, c2,

        nInnerRounds = key.length / 4 - 2, // key.length === 2 ?
        i,
        kIndex = 4,
        table = this._tables[1],

        // load up the tables
        table0    = table[0],
        table1    = table[1],
        table2    = table[2],
        table3    = table[3],
        sbox  = table[4];

    // Inner rounds. Cribbed from OpenSSL.
    for (i = 0; i < nInnerRounds; i++) {
      a2 = table0[a>>>24] ^ table1[b>>16 & 255] ^ table2[c>>8 & 255] ^ table3[d & 255] ^ key[kIndex];
      b2 = table0[b>>>24] ^ table1[c>>16 & 255] ^ table2[d>>8 & 255] ^ table3[a & 255] ^ key[kIndex + 1];
      c2 = table0[c>>>24] ^ table1[d>>16 & 255] ^ table2[a>>8 & 255] ^ table3[b & 255] ^ key[kIndex + 2];
      d  = table0[d>>>24] ^ table1[a>>16 & 255] ^ table2[b>>8 & 255] ^ table3[c & 255] ^ key[kIndex + 3];
      kIndex += 4;
      a=a2; b=b2; c=c2;
    }

    // Last round.
    for (i = 0; i < 4; i++) {
      out[(3 & -i) + offset] =
        sbox[a>>>24      ]<<24 ^
        sbox[b>>16  & 255]<<16 ^
        sbox[c>>8   & 255]<<8  ^
        sbox[d      & 255]     ^
        key[kIndex++];
      a2=a; a=b; b=c; c=d; d=a2;
    }
  }
};

/**
 * Decrypt bytes using AES-128 with CBC and PKCS#7 padding.
 * @param encrypted {Uint8Array} the encrypted bytes
 * @param key {Uint32Array} the bytes of the decryption key
 * @param initVector {Uint32Array} the initialization vector (IV) to
 * use for the first round of CBC.
 * @return {Uint8Array} the decrypted bytes
 *
 * @see http://en.wikipedia.org/wiki/Advanced_Encryption_Standard
 * @see http://en.wikipedia.org/wiki/Block_cipher_mode_of_operation#Cipher_Block_Chaining_.28CBC.29
 * @see https://tools.ietf.org/html/rfc2315
 */
decrypt = function(encrypted, key, initVector) {
  var
    // word-level access to the encrypted bytes
    encrypted32 = new Int32Array(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength >> 2),

    decipher = new AES(Array.prototype.slice.call(key)),

    // byte and word-level access for the decrypted output
    decrypted = new Uint8Array(encrypted.byteLength),
    decrypted32 = new Int32Array(decrypted.buffer),

    // temporary variables for working with the IV, encrypted, and
    // decrypted data
    init0, init1, init2, init3,
    encrypted0, encrypted1, encrypted2, encrypted3,

    // iteration variable
    wordIx;

  // pull out the words of the IV to ensure we don't modify the
  // passed-in reference and easier access
  init0 = initVector[0];
  init1 = initVector[1];
  init2 = initVector[2];
  init3 = initVector[3];

  // decrypt four word sequences, applying cipher-block chaining (CBC)
  // to each decrypted block
  for (wordIx = 0; wordIx < encrypted32.length; wordIx += 4) {
    // convert big-endian (network order) words into little-endian
    // (javascript order)
    encrypted0 = ntoh(encrypted32[wordIx]);
    encrypted1 = ntoh(encrypted32[wordIx + 1]);
    encrypted2 = ntoh(encrypted32[wordIx + 2]);
    encrypted3 = ntoh(encrypted32[wordIx + 3]);

    // decrypt the block
    decipher.decrypt(encrypted0,
                     encrypted1,
                     encrypted2,
                     encrypted3,
                     decrypted32,
                     wordIx);

    // XOR with the IV, and restore network byte-order to obtain the
    // plaintext
    decrypted32[wordIx]     = ntoh(decrypted32[wordIx] ^ init0);
    decrypted32[wordIx + 1] = ntoh(decrypted32[wordIx + 1] ^ init1);
    decrypted32[wordIx + 2] = ntoh(decrypted32[wordIx + 2] ^ init2);
    decrypted32[wordIx + 3] = ntoh(decrypted32[wordIx + 3] ^ init3);

    // setup the IV for the next round
    init0 = encrypted0;
    init1 = encrypted1;
    init2 = encrypted2;
    init3 = encrypted3;
  }

  return decrypted;
};

AsyncStream = function() {
  this.jobs = [];
  this.delay = 1;
  this.timeout_ = null;
};
AsyncStream.prototype = new videojs.Hls.Stream();
AsyncStream.prototype.processJob_ = function() {
  this.jobs.shift()();
  if (this.jobs.length) {
    this.timeout_ = setTimeout(this.processJob_.bind(this),
                               this.delay);
  } else {
    this.timeout_ = null;
  }
};
AsyncStream.prototype.push = function(job) {
  this.jobs.push(job);
  if (!this.timeout_) {
    this.timeout_ = setTimeout(this.processJob_.bind(this),
                               this.delay);
  }
};

Decrypter = function(encrypted, key, initVector, done) {
  var
    step = Decrypter.STEP,
    encrypted32 = new Int32Array(encrypted.buffer),
    decrypted = new Uint8Array(encrypted.byteLength),
    i = 0;
  this.asyncStream_ = new AsyncStream();

  // split up the encryption job and do the individual chunks asynchronously
  this.asyncStream_.push(this.decryptChunk_(encrypted32.subarray(i, i + step),
                                            key,
                                            initVector,
                                            decrypted,
                                            i));
  for (i = step; i < encrypted32.length; i += step) {
    initVector = new Uint32Array([
      ntoh(encrypted32[i - 4]),
      ntoh(encrypted32[i - 3]),
      ntoh(encrypted32[i - 2]),
      ntoh(encrypted32[i - 1])
    ]);
    this.asyncStream_.push(this.decryptChunk_(encrypted32.subarray(i, i + step),
                                              key,
                                              initVector,
                                              decrypted));
  }
  // invoke the done() callback when everything is finished
  this.asyncStream_.push(function() {
    // remove pkcs#7 padding from the decrypted bytes
    done(null, unpad(decrypted));
  });
};
Decrypter.prototype = new videojs.Hls.Stream();
Decrypter.prototype.decryptChunk_ = function(encrypted, key, initVector, decrypted) {
  return function() {
    var bytes = decrypt(encrypted,
                        key,
                        initVector);
    decrypted.set(bytes, encrypted.byteOffset);
  };
};
// the maximum number of bytes to process at one time
Decrypter.STEP = 4 * 8000;

// exports
videojs.Hls.decrypt = decrypt;
videojs.Hls.Decrypter = Decrypter;
videojs.Hls.AsyncStream = AsyncStream;

})(window, window.videojs, window.pkcs7.unpad);

(function(window) {
  var textRange = function(range, i) {
    return range.start(i) + '-' + range.end(i);
  };
  var module = {
    hexDump: function(data) {
      var
        bytes = Array.prototype.slice.call(data),
        step = 16,
        formatHexString = function(e, i) {
          var value = e.toString(16);
          return "00".substring(0, 2 - value.length) + value + (i % 2 ? ' ' : '');
        },
        formatAsciiString = function(e) {
          if (e >= 0x20 && e < 0x7e) {
            return String.fromCharCode(e);
          }
          return '.';
        },
        result = '',
        hex,
        ascii;
      for (var j = 0; j < bytes.length / step; j++) {
        hex = bytes.slice(j * step, j * step + step).map(formatHexString).join('');
        ascii = bytes.slice(j * step, j * step + step).map(formatAsciiString).join('');
        result += hex + ' ' + ascii + '\n';
      }
      return result;
    },
    tagDump: function(tag) {
      return module.hexDump(tag.bytes);
    },
    textRanges: function(ranges) {
      var result = '', i;
      for (i = 0; i < ranges.length; i++) {
        result += textRange(ranges, i) + ' ';
      }
      return result;
    }
  };

  window.videojs.Hls.utils = module;
})(this);
