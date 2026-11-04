package main

import (
	"encoding/binary"
	"testing"
)

func TestBrandMarkColorsMatchSuitePalette(t *testing.T) {
	tests := []struct {
		name   string
		point  iconPoint
		color  [3]byte
		inside bool
	}{
		{name: "rounded background", point: iconPoint{10, 10}, color: [3]byte{0x10, 0x21, 0x31}, inside: true},
		{name: "cyan mark", point: iconPoint{22, 17}, color: [3]byte{0x5b, 0xdc, 0xff}, inside: true},
		{name: "pink accent", point: iconPoint{46, 47}, color: [3]byte{0xff, 0x76, 0x9d}, inside: true},
		{name: "transparent corner", point: iconPoint{1, 1}, inside: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			color, inside := brandColorAt(test.point)
			if inside != test.inside || inside && color != test.color {
				t.Fatalf("brandColorAt(%v) = (%v, %t), want (%v, %t)", test.point, color, inside, test.color, test.inside)
			}
		})
	}
}

func TestIconDIBHasValidDimensionsAndTransparentMask(t *testing.T) {
	for _, size := range iconSizes {
		image := makeIconDIB(size)
		maskStride := ((size + 31) / 32) * 4
		wantSize := 40 + size*size*4 + maskStride*size
		if len(image) != wantSize {
			t.Fatalf("size %d DIB length = %d, want %d", size, len(image), wantSize)
		}
		if got := binary.LittleEndian.Uint32(image[4:8]); got != uint32(size) {
			t.Fatalf("size %d DIB width = %d", size, got)
		}
		if got := binary.LittleEndian.Uint32(image[8:12]); got != uint32(size*2) {
			t.Fatalf("size %d DIB height = %d", size, got)
		}
		if got := binary.LittleEndian.Uint16(image[14:16]); got != 32 {
			t.Fatalf("size %d DIB bit depth = %d, want 32", size, got)
		}
	}

	image := makeIconDIB(64)
	transparentPixel := 40 + (63-1)*64*4 + 1*4
	if alpha := image[transparentPixel+3]; alpha != 0 {
		t.Fatalf("transparent corner alpha = %d, want 0", alpha)
	}
	cyanPixel := 40 + (63-17)*64*4 + 22*4
	if got := [3]byte{image[cyanPixel+2], image[cyanPixel+1], image[cyanPixel]}; got != [3]byte{0x5b, 0xdc, 0xff} {
		t.Fatalf("cyan mark pixel = %v", got)
	}
}

func TestIconGroupUsesAllSizesAndResourceIds(t *testing.T) {
	images := make([][]byte, len(iconSizes))
	for index, size := range iconSizes {
		images[index] = makeIconDIB(size)
	}
	group, err := iconGroupResource(images)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(group), 6+14*len(iconSizes); got != want {
		t.Fatalf("group resource length = %d, want %d", got, want)
	}
	if got := binary.LittleEndian.Uint16(group[4:6]); got != uint16(len(iconSizes)) {
		t.Fatalf("group image count = %d, want %d", got, len(iconSizes))
	}
	for index, size := range iconSizes {
		entry := group[6+index*14 : 6+(index+1)*14]
		wantSize := byte(size)
		if size == 256 {
			wantSize = 0
		}
		if entry[0] != wantSize || entry[1] != wantSize {
			t.Fatalf("entry %d dimensions = %d x %d, want %d x %d", index, entry[0], entry[1], wantSize, wantSize)
		}
		if got := binary.LittleEndian.Uint16(entry[12:14]); got != uint16(index+1) {
			t.Fatalf("entry %d resource id = %d, want %d", index, got, index+1)
		}
	}
}
