package main

import (
	"net/http"
)

// AdsSettings is what the site needs to show ads. Everything comes from the admin settings:
//
//	ads_enabled      on/off switch for all ads
//	ad-iframe-src    URL of an ad page shown in the side column (wide screens)
//	ad-iframe-width  side column width (px)
//	ads_embed_code   ad-network embed code (HTML/JS). Rendered in a sandboxed frame without same-origin
//	                 access, so ad scripts cannot read the site's cookies or page.
//	ads_feed_every   show an ad after every N messages in the feed (0 = no in-feed ads)
//	ads_feed_height  in-feed ad height (px)
type AdsSettings struct {
	Enabled    bool   `json:"enabled"`
	Src        string `json:"src"`
	Width      int64  `json:"width"`
	EmbedCode  string `json:"embedCode"`
	FeedEvery  int64  `json:"feedEvery"`
	FeedHeight int64  `json:"feedHeight"`
}

func getAdsSettings(w http.ResponseWriter, r *http.Request) {
	c := settingConfig
	if !c.AdsEnabled {
		writeJSON(w, AdsSettings{})
		return
	}
	width := c.AdWidth
	if width <= 0 {
		width = 300
	}
	feedEvery := c.AdsFeedEvery
	if feedEvery < 0 || (c.AdSrc == "" && c.AdsEmbedCode == "") {
		feedEvery = 0
	}
	writeJSON(w, AdsSettings{
		Enabled:    c.AdSrc != "" || c.AdsEmbedCode != "",
		Src:        c.AdSrc,
		Width:      width,
		EmbedCode:  c.AdsEmbedCode,
		FeedEvery:  feedEvery,
		FeedHeight: c.AdsFeedHeight,
	})
}
