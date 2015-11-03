function monitor(options) {
    var player = this;

    // 视频监控
    player.on('waiting', function () {
        console.time('播放期间缓冲');
    });

    player.on('playing', function () {
        if (player.hasStarted()) {
            console.timeEnd('播放期间缓冲');
        }
        console.timeEnd('用户可感知的视频第一次加载时间');
        console.timeEnd('切换分辨率到播放的耗时');
    });

    player.on('buffering', function () {
        console.info('buffering');
    });

    player.on('resolutionchange', function () {
        console.info('成功切换分辨率');

    });

    player.on('resolutionchangebefore', function () {
        console.info('切换分辨率');
        console.time('切换分辨率到播放的耗时');
    });

    player.on('error', function (e) {
        player.src({
            src: player.getCache().src,
            type: 'application/x-mpegURL'
        });
        player.play();
    });

    player.on('fullscreenchange', function (e) {
        console.info('全屏状态切换');
    });

    player.on('pause', function (e) {
        console.info('暂停');
    });

    $('.vjs-big-play-button').on('click', function () {
        if (!player.me.autoplay) {
            console.time('用户可感知的视频第一次加载时间');
        }
    });

    player.on('ready', function () {
        if (player.me.autoplay) {
            console.time('用户可感知的视频第一次加载时间');
        }
    });
};

videojs.plugin('monitor', monitor);
