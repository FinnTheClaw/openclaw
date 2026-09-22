package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type htmlBlockErrorTranslator struct{}

func (htmlBlockErrorTranslator) Translate(context.Context, string, string, string) (string, error) {
	return "", errors.New("html translation failed")
}

func (htmlBlockErrorTranslator) TranslateRaw(context.Context, string, string, string) (string, error) {
	return "", errors.New("html translation failed")
}

func (htmlBlockErrorTranslator) Close() {}

func TestTranslateHTMLBlocksPropagatesTranslatorError(t *testing.T) {
	_, err := translateHTMLBlocks(
		context.Background(),
		htmlBlockErrorTranslator{},
		"<div>translate me</div>\n",
		"en",
		"fr",
	)
	if err == nil || !strings.Contains(err.Error(), "html translation failed") {
		t.Fatalf("expected HTML translation error, got %v", err)
	}
}
