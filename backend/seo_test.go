package main

import "testing"

func TestThinMessage(t *testing.T) {
	cases := []struct {
		text string
		thin bool
	}{
		{"", true},
		{"!מחק", true},
		{"רץ ברשת", true},
		{"❌ פורמט שגוי! שימוש נכון: !ערוך תוכן חדש", true},
		{"שימוש נכון: !ערוך", true},
		{"!ערוך תוכן חדש שמאריך את ההודעה הרבה מעבר לסף", true},
		{"[image-embedded#](/api/files/abc)", true}, // a picture only
		{"יהדות התורה פוזלת לשמאל? דוד שרן, מנכ״ל הליכוד, אומר שלא", false},
		{"ההודעה הזאת ארוכה מספיק וגם אמיתית", false},
	}
	for _, c := range cases {
		if got := thinMessage(plainText(c.text)); got != c.thin {
			t.Errorf("thinMessage(%q) = %v, want %v", c.text, got, c.thin)
		}
	}
}
