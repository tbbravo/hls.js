/**
 * 计时器
 * 用法和console.time()、console.timeEnd()类似
 */
window.videoMonitor = {};

videoMonitor.db = {};

videoMonitor.time = function (key) {
    videoMonitor.db[key] = {};
    videoMonitor.db[key].startTime = new Date();
    return videoMonitor.db[key].startTime;
}

videoMonitor.timeEnd = function (key) {
    var debug = (location.search.indexOf('debug') >= 0) ? true : false;
    var timer = videoMonitor.db[key];

    if (!timer || timer.used) {
        return;
    }

    timer.endTime = new Date();
    timer.costTime = timer.endTime - timer.startTime;
    if (debug) {
        console.log(key, timer.costTime);
    }
    timer.used = true;
    return timer.costTime;
}

function monitor(options) {
    var player = this;

    // 视频监控
    player.on('waiting', function () {
        videoMonitor.time('播放期间缓冲');
    });

    player.on('playing', function () {
        if (player.hasStarted()) {
            videoMonitor.timeEnd('播放期间缓冲');
            console.log('播放期间缓冲', new Date());
        }
        videoMonitor.timeEnd('用户可感知的视频第一次加载时间');
        videoMonitor.timeEnd('切换分辨率到播放的耗时');
    });

    player.on('buffering', function () {
        console.info('buffering');
    });

    player.on('resolutionchange', function () {
        console.info('成功切换分辨率');

    });

    player.on('resolutionchangebefore', function () {
        console.info('切换分辨率');
        videoMonitor.time('切换分辨率到播放的耗时');
    });

    // player.on('error', function (e) {
    //     player.src({
    //         src: player.getCache().src,
    //         type: 'application/x-mpegURL'
    //     });
    //     player.play();
    // });

    player.on('fullscreenchange', function (e) {
        console.info('全屏状态切换');
    });

    player.on('pause', function (e) {
        console.info('暂停');
    });

    $('.vjs-big-play-button').on('click', function () {
        if (!player.me.autoplay) {
            videoMonitor.time('用户可感知的视频第一次加载时间');
        }
    });

    player.on('ready', function () {
        if (player.me.autoplay) {
            videoMonitor.time('用户可感知的视频第一次加载时间');
        }
    });
};

videojs.plugin('monitor', monitor);
