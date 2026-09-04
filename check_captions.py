#!/usr/bin/env python3
"""
Check all captions stored in the database
Run: python check_captions.py
"""

import psycopg2
import json
from datetime import datetime

DATABASE_URL = "postgresql://neondb_owner:npg_Ft7zdnlh1jWL@ep-quiet-fire-ay6p33yj-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require"

def check_all_captions():
    print("=" * 70)
    print("🔍 CHECKING ALL CAPTIONS IN DATABASE")
    print("=" * 70)
    
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        # Get all scraped data
        cur.execute("""
            SELECT id, job_id, usernames, results, created_at 
            FROM scraped_reels 
            ORDER BY created_at DESC
        """)
        
        all_rows = cur.fetchall()
        
        if not all_rows:
            print("\n❌ No data found in database")
            return
        
        print(f"\n📊 Found {len(all_rows)} scraped jobs\n")
        
        total_profiles = 0
        total_reels = 0
        total_captions = 0
        all_captions = []
        
        for row in all_rows:
            job_id = row[1]
            usernames = row[2]
            results = row[3]
            created_at = row[4]
            
            print(f"📅 Job: {job_id[:8]}... ({created_at})")
            print(f"   Usernames: {usernames}")
            
            if not results:
                print("   ❌ No results")
                continue
            
            for profile in results:
                username = profile.get('username', 'unknown')
                reels = profile.get('reels', [])
                status = profile.get('status', 'ok')
                
                print(f"\n   👤 @{username} (status: {status})")
                print(f"      📹 Reels: {len(reels)}")
                
                reel_count = 0
                caption_count = 0
                
                for reel in reels:
                    if isinstance(reel, dict):
                        url = reel.get('url', '')
                        caption = reel.get('caption', '')
                        reel_count += 1
                        
                        if caption and caption.strip():
                            caption_count += 1
                            total_captions += 1
                            all_captions.append({
                                'username': username,
                                'url': url,
                                'caption': caption,
                                'length': len(caption)
                            })
                            print(f"         ✅ #{reel_count}: {url[:60]}...")
                            print(f"            📝 {caption[:80]}...")
                        else:
                            print(f"         ❌ #{reel_count}: {url[:60]}... (NO CAPTION)")
                    else:
                        reel_count += 1
                        print(f"         ❌ #{reel_count}: {str(reel)[:60]}... (NO CAPTION)")
                
                total_profiles += 1
                total_reels += reel_count
                
                if caption_count > 0:
                    print(f"      📊 Captions: {caption_count}/{reel_count}")
                else:
                    print(f"      📊 Captions: 0/{reel_count} ❌")
            
            print("\n" + "-" * 50)
        
        # Summary
        print("\n" + "=" * 70)
        print("📊 SUMMARY")
        print("=" * 70)
        print(f"   Total Jobs: {len(all_rows)}")
        print(f"   Total Profiles: {total_profiles}")
        print(f"   Total Reels: {total_reels}")
        print(f"   Total Captions: {total_captions}")
        
        # Show all captions found
        if all_captions:
            print("\n📝 ALL CAPTIONS FOUND:")
            print("-" * 70)
            for i, item in enumerate(all_captions, 1):
                print(f"\n{i}. @{item['username']}")
                print(f"   URL: {item['url'][:80]}...")
                print(f"   📝 {item['caption'][:150]}...")
                print(f"   Length: {item['length']} characters")
        else:
            print("\n❌ NO CAPTIONS FOUND IN DATABASE")
            print("\n   Possible issues:")
            print("   1. Render scraper not sending captions")
            print("   2. Vercel not storing captions")
            print("   3. Caption service not returning captions")
        
        cur.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

def check_latest_captions_only():
    """Check only the latest job's captions"""
    print("\n" + "=" * 70)
    print("🔍 CHECKING LATEST JOB CAPTIONS")
    print("=" * 70)
    
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        # Get latest job
        cur.execute("""
            SELECT results, created_at 
            FROM scraped_reels 
            ORDER BY created_at DESC 
            LIMIT 1
        """)
        
        result = cur.fetchone()
        
        if not result:
            print("\n❌ No data found")
            return
        
        results = result[0]
        created_at = result[1]
        
        print(f"\n📅 Latest job: {created_at}\n")
        
        captions_found = []
        
        for profile in results:
            username = profile.get('username', 'unknown')
            reels = profile.get('reels', [])
            
            print(f"👤 @{username}")
            print(f"   📹 Reels: {len(reels)}")
            
            for reel in reels:
                if isinstance(reel, dict):
                    url = reel.get('url', '')
                    caption = reel.get('caption', '')
                    if caption and caption.strip():
                        captions_found.append({
                            'username': username,
                            'url': url,
                            'caption': caption
                        })
                        print(f"   ✅ {url[:60]}...")
                        print(f"      📝 {caption[:80]}...")
                    else:
                        print(f"   ❌ {url[:60]}... (NO CAPTION)")
                else:
                    print(f"   ❌ {str(reel)[:60]}... (NO CAPTION)")
        
        if captions_found:
            print(f"\n✅ Found {len(captions_found)} captions in latest job")
        else:
            print("\n❌ No captions found in latest job")
            
        cur.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == '--latest':
        check_latest_captions_only()
    else:
        check_all_captions()