//go:build ignore

// Standard-library-only helpers for the portable Windows build script.
package main

import (
	"archive/zip"
	"flag"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

func main() {
	archive := flag.String("zip", "", "output ZIP file")
	dir := flag.String("dir", "", "directory to archive")
	flag.Parse()
	if *archive == "" || *dir == "" {
		log.Fatal("provide -zip with -dir")
	}
	if err := writeArchive(*archive, *dir); err != nil {
		log.Fatal(err)
	}
}

func writeArchive(path, dir string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	writer := zip.NewWriter(file)
	err = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		name, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		destination, err := writer.Create(filepath.ToSlash(name))
		if err != nil {
			return err
		}
		source, err := os.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(destination, source)
		closeErr := source.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
	zipErr := writer.Close()
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if zipErr != nil {
		return zipErr
	}
	return closeErr
}
